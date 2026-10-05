import { createHash } from "node:crypto";
import { getAuth } from "@clerk/express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getDirectOpenAIFallback, getOpenAIClient, openaiVisionModel } from "@workspace/integrations-openai-ai-server";
import { batchProcess } from "@workspace/integrations-openai-ai-server/batch";
import { db } from "@workspace/db";
import { boostsTable, checkoutRecordsTable, notificationsTable, ordersTable, payoutLedgerTable, productsTable, protectionCasesTable, sellerPayoutAccountsTable, usersTable, withdrawalsTable } from "@workspace/db/schema";
import { getUncachableStripeClient } from "../lib/stripeClient";
import { publicStoredImageUrl, validateStoredImageUrl } from "./storage";

const router: IRouter = Router();
const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const analysisHits = new Map<string, number[]>();
const boostPrices: Record<string, number> = { basic: 0.99, plus: 1.99, premium: 2.99 };

type AuthedRequest = Request & { userId?: string };
async function auth(req: Request, res: Response, next: NextFunction) {
  const userId = getAuth(req).userId;
  if (!userId) return void res.status(401).json({ error: "Authentication required" });
  await db.insert(usersTable).values({ id: userId, name: "LumaLoop member", avatar: "", location: "United Kingdom" }).onConflictDoNothing();
  (req as AuthedRequest).userId = userId;
  next();
}
function text(value: unknown, max = 4000): string | undefined {
  return typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : undefined;
}
function price(value: unknown): number | undefined {
  const n = Number(value); return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? Math.round(n * 100) / 100 : undefined;
}
function protectionFee(listingPrice: number) {
  // Transparent buyer-only fee: 5% plus £0.49, capped at £20.00.
  return Math.min(20, Math.round((listingPrice * 0.05 + 0.49) * 100) / 100);
}
function safeUrl(value: unknown): string | undefined {
  const url = text(value, 2000);
  // Stripe-hosted onboarding returns in the system browser. Native Expo must be
  // allowed to return to the app, but only to our fixed scheme/path; arbitrary
  // custom-scheme URLs would be an open redirect.
  return url && (
    /^https:\/\//i.test(url)
    || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/(?:balance(?:[/?#]|$))?/i.test(url)
    || /^lumaloop:\/\/balance(?:[/?#]|$)/i.test(url)
  ) ? url : undefined;
}
function allowAnalysis(userId: string): boolean {
  const now = Date.now(), recent = (analysisHits.get(userId) ?? []).filter((hit) => now - hit < 60_000);
  if (recent.length >= 6) return false;
  recent.push(now); analysisHits.set(userId, recent); return true;
}

function amount(value: string | number | null | undefined): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
}

function providerDefinitelyRejected(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error
    && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500;
}

function withdrawalPayload(withdrawal: typeof withdrawalsTable.$inferSelect) {
  return {
    id: withdrawal.id,
    amount: amount(withdrawal.amount),
    status: withdrawal.status,
    providerTransferId: withdrawal.providerTransferId,
    failureReason: withdrawal.failureReason,
    reversedAmount: amount(withdrawal.reversedAmount),
    createdAt: withdrawal.createdAt.toISOString(),
    completedAt: withdrawal.completedAt?.toISOString() ?? null,
  };
}

function payoutAccountPayload(account: typeof sellerPayoutAccountsTable.$inferSelect | undefined) {
  return account ? {
    provider: account.provider,
    accountId: account.providerAccountId,
    status: account.status,
    payoutsEnabled: account.payoutsEnabled,
    detailsSubmitted: account.detailsSubmitted,
    disabledReason: account.disabledReason,
  } : { provider: "stripe", accountId: null, status: "not_started", payoutsEnabled: false, detailsSubmitted: false, disabledReason: null };
}

async function ensureSellerLedger(userId: string): Promise<void> {
  const existing = await db.select({ ledger: payoutLedgerTable, checkout: checkoutRecordsTable })
    .from(payoutLedgerTable)
    .innerJoin(ordersTable, eq(payoutLedgerTable.orderId, ordersTable.id))
    .leftJoin(checkoutRecordsTable, eq(ordersTable.stripeCheckoutSessionId, checkoutRecordsTable.stripeCheckoutSessionId))
    .where(eq(payoutLedgerTable.sellerId, userId));
  for (const { ledger, checkout } of existing) {
    if (checkout?.status === "completed") continue;
    if ((ledger.status === "pending" || ledger.status === "available") && !ledger.withdrawalId) {
      await db.update(payoutLedgerTable).set({ status: "cancelled", availableAt: null })
        .where(and(eq(payoutLedgerTable.id, ledger.id), eq(payoutLedgerTable.sellerId, userId), isNull(payoutLedgerTable.withdrawalId)));
    } else if (ledger.status === "paid_out" || ledger.withdrawalId) {
      // Never rewrite a provider-paid withdrawal as cancelled. Hide the
      // associated credit from normal balances pending operator reconciliation.
      await db.update(payoutLedgerTable).set({ status: "verification_hold" })
        .where(and(eq(payoutLedgerTable.id, ledger.id), eq(payoutLedgerTable.sellerId, userId)));
    }
  }
  const sales = await db.select({ order: ordersTable, product: productsTable })
    .from(ordersTable)
    .innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
    .innerJoin(checkoutRecordsTable, eq(ordersTable.stripeCheckoutSessionId, checkoutRecordsTable.stripeCheckoutSessionId))
    .where(and(eq(productsTable.sellerId, userId), eq(checkoutRecordsTable.status, "completed")));
  if (!sales.length) return;
  await db.insert(payoutLedgerTable).values(sales.map(({ order, product }) => ({
    id: `ledger_${order.id}`,
    sellerId: userId,
    orderId: order.id,
    grossAmount: order.amount,
    platformFee: "0",
    netAmount: order.amount,
    status: order.status === "delivered" ? "available" : order.status === "cancelled" ? "cancelled" : "pending",
    availableAt: order.status === "delivered" ? order.placedAt : null,
    createdAt: order.placedAt,
  }))).onConflictDoNothing({ target: payoutLedgerTable.orderId });
}

router.get("/commerce/balance", auth, async (req, res): Promise<void> => {
  const userId = (req as AuthedRequest).userId!;
  await ensureSellerLedger(userId);
  const [ledgerRows, withdrawalRows, payoutAccount] = await Promise.all([
    db.select({ ledger: payoutLedgerTable, order: ordersTable, product: productsTable })
      .from(payoutLedgerTable)
      .innerJoin(ordersTable, eq(payoutLedgerTable.orderId, ordersTable.id))
      .innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
      .where(eq(payoutLedgerTable.sellerId, userId))
      .orderBy(desc(payoutLedgerTable.createdAt)),
    db.select().from(withdrawalsTable)
      .where(eq(withdrawalsTable.sellerId, userId))
      .orderBy(desc(withdrawalsTable.createdAt)),
    db.select().from(sellerPayoutAccountsTable).where(eq(sellerPayoutAccountsTable.sellerId, userId)).limit(1).then((rows) => rows[0]),
  ]);
  const entries = ledgerRows.map(({ ledger, order, product }) => ({
    id: ledger.id,
    orderId: order.id,
    title: product.title,
    grossAmount: amount(ledger.grossAmount),
    platformFee: amount(ledger.platformFee),
    netAmount: amount(ledger.netAmount),
    status: ledger.status,
    orderStatus: order.status,
    createdAt: ledger.createdAt.toISOString(),
    availableAt: ledger.availableAt?.toISOString() ?? null,
    paidAt: ledger.paidAt?.toISOString() ?? null,
  }));
  const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
  const confirmedSales = entries.filter((entry) => entry.status !== "cancelled");
  const grossSales = sum(confirmedSales.map((entry) => entry.grossAmount));
  const platformFees = sum(confirmedSales.map((entry) => entry.platformFee));
  const pendingFunds = sum(entries.filter((entry) => entry.status === "pending").map((entry) => entry.netAmount));
  const availableFunds = sum(entries.filter((entry) => entry.status === "available").map((entry) => entry.netAmount));
  const paidLedgerFunds = sum(entries.filter((entry) => entry.status === "paid_out").map((entry) => entry.netAmount));
  const reversedPendingFunds = sum(withdrawalRows.filter((row) => row.status === "partially_reversed").map((row) => amount(row.reversedAmount)));
  // A partial provider reversal is neither seller-available nor paid out while
  // operations reconcile its value-level allocation.
  const paidOutFunds = Math.max(0, Math.round((paidLedgerFunds - reversedPendingFunds) * 100) / 100);
  const payoutStatus = availableFunds > 0 ? "ready" : pendingFunds > 0 ? "pending" : "no_funds";
  res.json({
    currency: "GBP",
    grossSales,
    platformFees,
    pendingFunds,
    availableFunds,
    paidOutFunds,
    reversedPendingFunds,
    payoutStatus,
    payoutAccount: payoutAccountPayload(payoutAccount),
    sales: entries,
    payouts: withdrawalRows.map(withdrawalPayload),
  });
});

router.get("/commerce/payout-account", auth, async (req, res): Promise<void> => {
  const userId = (req as AuthedRequest).userId!;
  const account = (await db.select().from(sellerPayoutAccountsTable)
    .where(eq(sellerPayoutAccountsTable.sellerId, userId)).limit(1))[0];
  res.json(payoutAccountPayload(account));
});

router.post("/commerce/payout-account/onboard", auth, async (req, res): Promise<void> => {
  const userId = (req as AuthedRequest).userId!;
  const refreshUrl = safeUrl(req.body?.refreshUrl);
  const returnUrl = safeUrl(req.body?.returnUrl);
  if (!refreshUrl || !returnUrl) return void res.status(400).json({ error: "HTTPS refreshUrl and returnUrl are required." });
  let account = (await db.select().from(sellerPayoutAccountsTable)
    .where(eq(sellerPayoutAccountsTable.sellerId, userId)).limit(1))[0];
  const stripe = await getUncachableStripeClient();
  if (!account) {
    const created = await stripe.accounts.create({
      type: "express",
      country: "GB",
      capabilities: { transfers: { requested: true } },
      metadata: { sellerId: userId },
    }, { idempotencyKey: `seller-connect:${userId}` });
    await db.insert(sellerPayoutAccountsTable).values({
      sellerId: userId, providerAccountId: created.id,
      status: created.payouts_enabled ? "active" : "pending",
      chargesEnabled: created.charges_enabled, payoutsEnabled: created.payouts_enabled,
      detailsSubmitted: created.details_submitted, disabledReason: created.requirements?.disabled_reason ?? null,
    }).onConflictDoNothing();
    account = (await db.select().from(sellerPayoutAccountsTable)
      .where(eq(sellerPayoutAccountsTable.sellerId, userId)).limit(1))[0];
  }
  if (!account) throw new Error("Could not save seller payout account.");
  const link = await stripe.accountLinks.create({
    account: account.providerAccountId, refresh_url: refreshUrl, return_url: returnUrl, type: "account_onboarding",
  });
  res.status(201).json({ ...payoutAccountPayload(account), onboardingUrl: link.url });
});

router.post("/commerce/balance/withdraw", auth, async (req, res): Promise<void> => {
  const userId = (req as AuthedRequest).userId!;
  const idempotencyKey = text(req.get("Idempotency-Key"), 200);
  if (!idempotencyKey) {
    res.status(400).json({ error: "A valid Idempotency-Key is required." });
    return;
  }
  let existing = (await db.select().from(withdrawalsTable).where(and(
    eq(withdrawalsTable.sellerId, userId),
    eq(withdrawalsTable.idempotencyKey, idempotencyKey),
  )).limit(1))[0];
  if (existing && existing.status !== "reserved") {
    res.status(200).json(withdrawalPayload(existing));
    return;
  }

  const account = (await db.select().from(sellerPayoutAccountsTable).where(eq(sellerPayoutAccountsTable.sellerId, userId)).limit(1))[0];
  if (!account || !account.payoutsEnabled || account.status !== "active") {
    res.status(409).json({ error: "Complete and verify Stripe payout onboarding before withdrawing." });
    return;
  }
  let withdrawal: typeof withdrawalsTable.$inferSelect | null = existing ?? null;
  try {
    if (!withdrawal) withdrawal = await db.transaction(async (tx) => {
    const withdrawalId = id("withdrawal");
    // Claiming the rows in the UPDATE makes concurrent withdrawal requests
    // mutually exclusive without trusting an amount supplied by the client.
    const claimed = await tx.update(payoutLedgerTable).set({
      status: "reserved",
      withdrawalId,
      paidAt: null,
    }).where(and(
      eq(payoutLedgerTable.sellerId, userId),
      eq(payoutLedgerTable.status, "available"),
      isNull(payoutLedgerTable.withdrawalId),
    )).returning();
    if (!claimed.length) return null;
    const total = Math.round(claimed.reduce((sum, entry) => sum + Number(entry.netAmount), 0) * 100) / 100;
    const [created] = await tx.insert(withdrawalsTable).values({
      id: withdrawalId,
      sellerId: userId,
      amount: String(total),
      status: "reserved",
      idempotencyKey,
    }).returning();
    return created;
    });
  } catch (error) {
    if (!(typeof error === "object" && error && "code" in error && error.code === "23505")) throw error;
    existing = (await db.select().from(withdrawalsTable).where(and(eq(withdrawalsTable.sellerId, userId), eq(withdrawalsTable.idempotencyKey, idempotencyKey))).limit(1))[0];
    if (!existing) throw error;
    if (existing.status !== "reserved") {
      res.status(200).json(withdrawalPayload(existing));
      return;
    }
    withdrawal = existing;
  }
  if (!withdrawal) {
    res.status(409).json({ error: "There are no server-confirmed funds available to withdraw." });
    return;
  }
  let transferId: string;
  try {
    const transfer = await (await getUncachableStripeClient()).transfers.create({
      amount: Math.round(Number(withdrawal.amount) * 100),
      currency: "gbp",
      destination: account.providerAccountId,
      metadata: { withdrawalId: withdrawal.id, sellerId: userId },
    }, { idempotencyKey: `withdrawal:${userId}:${idempotencyKey}` });
    transferId = transfer.id;
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 1000) : "Stripe transfer failed.";
    // Timeouts and 5xx failures are ambiguous: Stripe may have accepted the
    // idempotent request. Preserve the reservation so a same-key retry can
    // retrieve that transfer instead of ever paying these rows twice.
    if (!providerDefinitelyRejected(error)) {
      await db.update(withdrawalsTable).set({ failureReason: reason })
        .where(and(eq(withdrawalsTable.id, withdrawal!.id), eq(withdrawalsTable.status, "reserved")));
      res.status(502).json({ error: "Stripe transfer outcome is pending confirmation. Retry with the same idempotency key.", payout: withdrawalPayload(withdrawal) });
      return;
    }
    const [failed] = await db.transaction(async (tx) => {
      await tx.update(payoutLedgerTable).set({ status: "available", withdrawalId: null })
        .where(and(eq(payoutLedgerTable.withdrawalId, withdrawal!.id), eq(payoutLedgerTable.status, "reserved")));
      return tx.update(withdrawalsTable).set({ status: "failed", failureReason: reason })
        .where(and(eq(withdrawalsTable.id, withdrawal!.id), eq(withdrawalsTable.status, "reserved"))).returning();
    });
    res.status(502).json({ error: "Stripe could not create the transfer. Funds remain available.", payout: failed ? withdrawalPayload(failed) : undefined });
    return;
  }
  // Do not catch this persistence transaction: after Stripe accepts a transfer,
  // releasing its reserved ledger rows would permit an unsafe second payment.
  const [paid] = await db.transaction(async (tx) => {
    await tx.update(payoutLedgerTable).set({ status: "paid_out", paidAt: new Date() })
      .where(and(eq(payoutLedgerTable.withdrawalId, withdrawal!.id), eq(payoutLedgerTable.status, "reserved")));
    return tx.update(withdrawalsTable).set({ status: "paid", providerTransferId: transferId, completedAt: new Date(), failureReason: null })
      .where(and(eq(withdrawalsTable.id, withdrawal!.id), eq(withdrawalsTable.status, "reserved"))).returning();
  });
  if (!paid) throw new Error("Withdrawal was no longer reserved after Stripe accepted the transfer.");
  await db.insert(notificationsTable).values({ id: id("notification"), recipientUserId: userId, type: "payout", title: "Payout sent", body: `${money(Number(paid.amount))} was sent to your Stripe account.` });
  res.status(201).json(withdrawalPayload(paid));
});

router.get("/commerce/fees", auth, (req, res) => {
  const listingPrice = price(req.query.price);
  if (!listingPrice) return void res.status(400).json({ error: "A valid listing price is required." });
  const buyerProtectionFee = protectionFee(listingPrice);
  res.json({ listingPrice, sellerFee: 0, buyerProtectionFee, total: Math.round((listingPrice + buyerProtectionFee) * 100) / 100 });
});

router.get("/commerce/offer-range/:productId", auth, async (req, res) => {
  const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
  const product = (await db.select().from(productsTable).where(eq(productsTable.id, productId ?? "")).limit(1))[0];
  if (!product) return void res.status(404).json({ error: "Listing not found" });
  const value = Number(product.price);
  res.json({ minimum: Math.round(value * 0.7 * 100) / 100, recommended: Math.round(value * 0.85 * 100) / 100, maximum: value });
});

async function analyze(images: string[]) {
  const messages = [{ role: "system" as const, content: "Return JSON only: {title,description,category,condition,keywords:string[],prices:{sellFaster:number,recommended:number,maximum:number}}. Describe only visible facts. Prices are GBP positive numbers. This is a private draft, never state it is published." },
    { role: "user" as const, content: [{ type: "text" as const, text: "Analyse these stored marketplace photos." }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url: publicStoredImageUrl(url) } }))] }];
  let response;
  try {
    response = await getOpenAIClient().chat.completions.create({ model: openaiVisionModel, max_completion_tokens: 900, messages });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
    const unavailable = status === 404 && error instanceof Error && /Replit AI Integrations is not configured/i.test(error.message);
    const fallback = unavailable ? getDirectOpenAIFallback() : null;
    if (!fallback) throw error;
    response = await fallback.chat.completions.create({ model: "gpt-4o-mini", max_completion_tokens: 900, messages });
  }
  const raw = response.choices[0]?.message.content;
  if (!raw) throw new Error("The analysis service returned no result.");
  const parsed: unknown = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ""));
  const item = parsed as Record<string, unknown>, prices = item.prices as Record<string, unknown>;
  if (!text(item.title, 140) || !text(item.description) || !text(item.category, 80) || !text(item.condition, 80) || !Array.isArray(item.keywords) || !prices || !price(prices.sellFaster) || !price(prices.recommended) || !price(prices.maximum)) throw new Error("The analysis service returned an invalid draft.");
  return { title: text(item.title, 140), description: text(item.description), category: text(item.category, 80), condition: text(item.condition, 80), keywords: item.keywords.filter((x): x is string => typeof x === "string").slice(0, 12), prices: { sellFaster: price(prices.sellFaster), recommended: price(prices.recommended), maximum: price(prices.maximum) } };
}
router.post("/commerce/ai/listing-analysis", auth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!;
  const images: unknown[] = Array.isArray(req.body?.images) ? req.body.images : [];
  if (images.length < 1 || images.length > 6 || !images.every((image: unknown): image is string => typeof image === "string") || !(await Promise.all(images.map((image) => validateStoredImageUrl(image, userId)))).every(Boolean)) return void res.status(400).json({ error: "Provide 1–6 uploaded JPEG, PNG, or WebP image URLs from this account." });
  if (!allowAnalysis(userId)) return void res.status(429).json({ error: "Photo analysis is limited to six requests per minute." });
  try { res.json(await analyze(images)); } catch (error) { req.log.error({ err: error }, "Listing analysis failed"); res.status(502).json({ error: "Listing analysis is temporarily unavailable." }); }
});
router.post("/commerce/ai/sell-everything", auth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!, groups: unknown[] = Array.isArray(req.body?.groups) ? req.body.groups : [];
  if (!groups.length || groups.length > 10 || !groups.every((g: unknown) => Array.isArray(g) && g.length && g.length <= 6 && g.every((image: unknown) => typeof image === "string"))) return void res.status(400).json({ error: "Provide 1–10 image groups, each containing 1–6 images." });
  const imageGroups = groups as string[][];
  if (!(await Promise.all(imageGroups.flat().map((image) => validateStoredImageUrl(image, userId)))).every(Boolean)) return void res.status(400).json({ error: "Images must be uploaded JPEG, PNG, or WebP images from this account." });
  if (!allowAnalysis(userId)) return void res.status(429).json({ error: "Photo analysis is limited to six requests per minute." });
  try { res.json({ items: await batchProcess(imageGroups, analyze, { concurrency: 2, retries: 2 }) }); } catch (error) { req.log.error({ err: error }, "Batch analysis failed"); res.status(502).json({ error: "Batch analysis is temporarily unavailable." }); }
});
router.post("/commerce/listings/batch", auth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!, items: Record<string, any>[] = Array.isArray(req.body?.items) ? req.body.items : [];
  const idempotencyKey = text(req.get("Idempotency-Key"), 200);
  if (!idempotencyKey) return void res.status(400).json({ error: "A valid Idempotency-Key is required." });
  if (!items.length || items.length > 20) return void res.status(400).json({ error: "Provide 1–20 listings to create." });
  const valid = await Promise.all(items.map(async (item) => {
    const images = Array.isArray(item?.images) ? item.images : [];
    return text(item?.title, 140) && price(item?.price) && text(item?.condition, 80) && text(item?.category, 80) && text(item?.description) && text(item?.location, 160) &&
      images.length > 0 && images.length <= 6 && images.every((image: unknown): image is string => typeof image === "string") && (await Promise.all(images.map((image) => validateStoredImageUrl(image, userId)))).every(Boolean);
  }));
  if (!valid.every(Boolean)) return void res.status(400).json({ error: "Every listing needs valid details and 1–6 uploaded images." });
  const created = await db.transaction(async (tx) => Promise.all(items.map(async (item, index) => {
    const listingId = `listing_${createHash("sha256").update(`${userId}:${idempotencyKey}:${index}`).digest("hex").slice(0, 24)}`;
    const [createdItem] = await tx.insert(productsTable).values({
    id: listingId, sellerId: userId, title: text(item.title, 140)!, price: String(price(item.price)!),
    currency: "GBP", condition: text(item.condition, 80)!, category: text(item.category, 80)!,
    description: text(item.description)!, location: text(item.location, 160)!, images: item.images,
    pickupAvailable: item.pickupAvailable === true, pickupArea: text(item.pickupArea, 120) ?? null,
    latitudeE6: Number.isInteger(item.latitudeE6) ? item.latitudeE6 : null, longitudeE6: Number.isInteger(item.longitudeE6) ? item.longitudeE6 : null,
    sellerAvailability: Array.isArray(item.sellerAvailability) ? item.sellerAvailability.filter((x: unknown): x is string => typeof x === "string").slice(0, 14) : [],
    keywords: Array.isArray(item.keywords) ? item.keywords.filter((x: unknown): x is string => typeof x === "string").slice(0, 12) : [],
    }).onConflictDoNothing().returning();
    if (createdItem) return createdItem;
    const [existingItem] = await tx.select().from(productsTable).where(eq(productsTable.id, listingId)).limit(1);
    if (!existingItem || existingItem.sellerId !== userId) throw new Error("Could not recover idempotent batch listing");
    return existingItem;
  })));
  // This endpoint is explicit user action; AI analysis itself remains draft-only.
  res.status(201).json({ items: created, total: created.length });
});

router.post("/commerce/checkout/listing", auth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!, productId = text(req.body?.productId, 200), successUrl = safeUrl(req.body?.successUrl), cancelUrl = safeUrl(req.body?.cancelUrl), key = text(req.get("Idempotency-Key"), 200);
  if (!productId || !successUrl || !cancelUrl || !key) return void res.status(400).json({ error: "Product, HTTPS URLs, and Idempotency-Key are required." });
  const existing = (await db.select().from(checkoutRecordsTable).where(and(eq(checkoutRecordsTable.userId, userId), eq(checkoutRecordsTable.idempotencyKey, key))).limit(1))[0];
  if (existing) {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(existing.stripeCheckoutSessionId);
    if (session.url) {
      return void res.status(200).json({ id: session.id, url: session.url });
    }
    return void res.status(409).json({ error: "This checkout session is no longer available. Please try again." });
  }
  const reservationId = id("checkout_reservation");
  const [product] = await db.update(productsTable).set({ checkoutReservationId: reservationId, checkoutReservedAt: new Date() })
    .where(and(eq(productsTable.id, productId), eq(productsTable.isSold, false), isNull(productsTable.checkoutReservationId)))
    .returning();
  if (!product || product.sellerId === userId) {
    if (product?.sellerId === userId) await db.update(productsTable).set({ checkoutReservationId: null, checkoutReservedAt: null }).where(eq(productsTable.id, product.id));
    return void res.status(409).json({ error: "This listing is unavailable for checkout." });
  }
  const listingPrice = Number(product.price), fee = protectionFee(listingPrice), stripe = await getUncachableStripeClient();
  let session;
  try {
    session = await stripe.checkout.sessions.create({ mode: "payment", success_url: successUrl, cancel_url: cancelUrl, line_items: [{ price_data: { currency: "gbp", product_data: { name: product.title }, unit_amount: Math.round(listingPrice * 100) }, quantity: 1 }, { price_data: { currency: "gbp", product_data: { name: "LumaLoop Buyer Protection" }, unit_amount: Math.round(fee * 100) }, quantity: 1 }], metadata: { kind: "listing", productId, buyerId: userId, reservationId } }, { idempotencyKey: `listing:${userId}:${key}` });
    await db.insert(checkoutRecordsTable).values({ id: id("checkout"), userId, productId, stripeCheckoutSessionId: session.id, idempotencyKey: key, amount: String(listingPrice + fee), listingAmount: String(listingPrice), buyerProtectionFee: String(fee) });
  } catch (error) {
    // Do not release a listing merely because persistence failed after Stripe
    // accepted creation. Cancel first; if cancellation is uncertain, preserve
    // the reservation rather than allowing a second buyer to pay.
    if (session?.id) {
      try {
        await stripe.checkout.sessions.expire(session.id);
        await db.update(productsTable).set({ checkoutReservationId: null, checkoutReservedAt: null })
          .where(and(eq(productsTable.id, product.id), eq(productsTable.checkoutReservationId, reservationId), eq(productsTable.isSold, false)));
      } catch { /* reservation is intentionally retained for reconciliation */ }
    } else {
      await db.update(productsTable).set({ checkoutReservationId: null, checkoutReservedAt: null })
        .where(and(eq(productsTable.id, product.id), eq(productsTable.checkoutReservationId, reservationId), eq(productsTable.isSold, false)));
    }
    throw error;
  }
  res.status(201).json({ id: session.id, url: session.url });
});

router.post("/commerce/boosts", auth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!, productId = text(req.body?.productId, 200), tier = text(req.body?.tier, 20), successUrl = safeUrl(req.body?.successUrl), cancelUrl = safeUrl(req.body?.cancelUrl);
  if (!productId || !tier || boostPrices[tier] === undefined || !successUrl || !cancelUrl) return void res.status(400).json({ error: "A listing, valid boost tier, and HTTPS URLs are required." });
  const product = (await db.select().from(productsTable).where(and(eq(productsTable.id, productId), eq(productsTable.sellerId, userId))).limit(1))[0];
  if (!product) return void res.status(404).json({ error: "Listing not found" });
  const amount = boostPrices[tier], boostId = id("boost"), session = await (await getUncachableStripeClient()).checkout.sessions.create({ mode: "payment", success_url: successUrl, cancel_url: cancelUrl, line_items: [{ price_data: { currency: "gbp", product_data: { name: `LumaLoop ${tier} boost` }, unit_amount: Math.round(amount * 100) }, quantity: 1 }], metadata: { kind: "boost", boostId, productId, sellerId: userId } });
  await db.insert(boostsTable).values({ id: boostId, productId, sellerId: userId, tier, amount: String(amount), stripeCheckoutSessionId: session.id });
  res.status(201).json({ id: session.id, url: session.url });
});

router.post("/commerce/protection-cases", auth, async (req, res) => {
  const userId = (req as AuthedRequest).userId!, orderId = text(req.body?.orderId, 200), reason = text(req.body?.reason, 30), details = text(req.body?.details, 4000);
  if (!orderId || !details || details.length < 10 || !reason || !["non_delivery", "misrepresentation", "counterfeit"].includes(reason)) return void res.status(400).json({ error: "A valid order, protection reason, and detailed description are required." });
  const order = (await db.select().from(ordersTable).where(and(eq(ordersTable.id, orderId), eq(ordersTable.buyerId, userId))).limit(1))[0];
  if (!order) return void res.status(404).json({ error: "Order not found" });
  const row = (await db.insert(protectionCasesTable).values({ id: id("protection"), orderId, buyerId: userId, reason, details }).returning())[0];
  await db.insert(notificationsTable).values({ id: id("notification"), recipientUserId: userId, type: "protection", title: "Buyer Protection case opened", body: "We received your case and will review it.", orderId });
  res.status(201).json({ id: row.id, orderId, reason, details, status: row.status, createdAt: row.createdAt.toISOString() });
});
export default router;