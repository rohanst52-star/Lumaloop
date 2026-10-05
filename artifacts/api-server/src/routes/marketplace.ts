import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import { clerkClient, getAuth } from "@clerk/express";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  conversationsTable,
  favouritesTable,
  messagesTable,
  moderationAuditTable,
  notificationsTable,
  offersTable,
  ordersTable,
  payoutLedgerTable,
  productsTable,
  reportsTable,
  reviewsTable,
  usersTable,
} from "@workspace/db/schema";
import { publicStoredImageUrl, validateStoredImageUrl } from "./storage";

type AuthedRequest = Request & { userId?: string; sessionClaims?: SessionClaims };
type SessionClaims = Record<string, unknown>;

const router: IRouter = Router();

const homeCategories = [
  { id: "home", name: "Home" },
  { id: "fashion", name: "Fashion" },
  { id: "accessories", name: "Accessories" },
  { id: "books", name: "Books" },
  { id: "tech", name: "Tech" },
  { id: "kids", name: "Kids" },
  { id: "collectibles", name: "Collectibles" },
  { id: "wellness", name: "Wellness" },
] as const;

const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

function pathParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function claimString(claims: SessionClaims, ...keys: string[]): string {
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function roleFromMetadata(metadata: Record<string, unknown>): string {
  const role = metadata.role;
  if (typeof role === "string" && role.trim()) return role.trim().toLowerCase();
  const roles = metadata.roles;
  if (Array.isArray(roles) && roles.some((item) => typeof item === "string" && ["admin", "moderator"].includes(item.toLowerCase()))) {
    return "moderator";
  }
  return "";
}

async function ensureUser(userId: string, claims: SessionClaims) {
  const firstName = claimString(claims, "first_name", "firstName");
  const lastName = claimString(claims, "last_name", "lastName");
  const email = claimString(claims, "email", "email_address", "primary_email_address");
  const claimedName = claimString(claims, "name", "full_name", "username");
  const name = claimedName || [firstName, lastName].filter(Boolean).join(" ") || email.split("@")[0] || "LumaLoop member";
  const avatar = claimString(claims, "image_url", "imageUrl", "picture");

  await db
    .insert(usersTable)
    .values({
      id: userId,
      name,
      avatar,
      location: "United Kingdom",
      bio: "",
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: { name, avatar },
    });
}

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = getAuth(req);
  const userId = String(auth?.sessionClaims?.userId || auth?.userId || "");
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  (req as AuthedRequest).userId = userId;
  (req as AuthedRequest).sessionClaims = (auth?.sessionClaims ?? {}) as SessionClaims;
  await ensureUser(userId, (auth?.sessionClaims ?? {}) as SessionClaims);
  next();
}

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = getAuth(req);
  const userId = String(auth?.sessionClaims?.userId || auth?.userId || "");
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  (req as AuthedRequest).userId = userId;
  (req as AuthedRequest).sessionClaims = (auth?.sessionClaims ?? {}) as SessionClaims;
  await ensureUser(userId, (auth?.sessionClaims ?? {}) as SessionClaims);
  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    const hasClerkRole = ["admin", "moderator"].includes(roleFromMetadata(clerkUser.publicMetadata));
    if (!hasClerkRole) {
      res.status(403).json({ error: "Moderator access required" });
      return;
    }
    next();
  } catch (error) {
    req.log.error({ err: error, userId }, "Could not verify Clerk moderator role");
    res.status(503).json({ error: "Moderator access could not be verified" });
  }
}

function isoDateOrFallback(value: Date | string | null | undefined): string {
  const date = value instanceof Date ? value : new Date(value ?? "");
  return Number.isNaN(date.getTime()) ? "2024-01-01T00:00:00.000Z" : date.toISOString();
}

type ReviewContext = {
  review: typeof reviewsTable.$inferSelect;
  reviewer: typeof usersTable.$inferSelect;
  product: typeof productsTable.$inferSelect;
};

function reviewPayload({ review, reviewer, product }: ReviewContext) {
  return {
    id: review.id,
    rating: review.rating,
    body: review.body,
    reviewerName: reviewer.name,
    reviewerAvatar: reviewer.avatar,
    productTitle: product.title,
    createdAt: isoDateOrFallback(review.createdAt),
  };
}

async function reviewsForSeller(sellerId: string) {
  return db
    .select({ review: reviewsTable, reviewer: usersTable, product: productsTable })
    .from(reviewsTable)
    .innerJoin(usersTable, eq(reviewsTable.buyerId, usersTable.id))
    .innerJoin(ordersTable, eq(reviewsTable.orderId, ordersTable.id))
    .innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
    .where(eq(reviewsTable.sellerId, sellerId))
    .orderBy(desc(reviewsTable.createdAt));
}

async function reviewForOrder(orderId: string) {
  const rows = await db
    .select({ review: reviewsTable, reviewer: usersTable, product: productsTable })
    .from(reviewsTable)
    .innerJoin(usersTable, eq(reviewsTable.buyerId, usersTable.id))
    .innerJoin(ordersTable, eq(reviewsTable.orderId, ordersTable.id))
    .innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
    .where(eq(reviewsTable.orderId, orderId))
    .limit(1);
  return rows[0] ? reviewPayload(rows[0]) : null;
}

async function profileFor(userId: string) {
  const rows = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const user = rows[0];
  if (!user) {
    return null;
  }
  const reviews = await reviewsForSeller(userId);
  const rating = reviews.length
    ? Number((reviews.reduce((total, row) => total + row.review.rating, 0) / reviews.length).toFixed(2))
    : 0;
  return {
    id: user.id,
    name: user.name,
    rating,
    reviewCount: reviews.length,
    reviews: reviews.map(reviewPayload),
    avatar: user.avatar,
    location: user.location,
    joinedAt: isoDateOrFallback(user.joinedAt),
    bio: user.bio,
  };
}

async function productFor(row: typeof productsTable.$inferSelect) {
  const seller = await profileFor(row.sellerId);
  if (!seller) {
    throw new Error(`Seller profile not found for listing ${row.id}`);
  }
  return {
    id: row.id,
    title: row.title,
    price: Number(row.price),
    currency: row.currency,
    condition: row.condition,
    category: row.category,
    description: row.description,
    location: row.location,
    images: row.images.map(publicStoredImageUrl),
    seller,
    createdAt: new Date(row.createdAt).toISOString(),
    favouriteCount: row.favouriteCount,
    pickupAvailable: row.pickupAvailable,
    pickupArea: row.pickupArea,
    sellerAvailability: row.sellerAvailability,
  };
}

async function orderPayload(order: typeof ordersTable.$inferSelect, product: typeof productsTable.$inferSelect) {
  return {
    id: order.id,
    product: await productFor(product),
    amount: Number(order.amount),
    buyerProtectionFee: Number(order.buyerProtectionFee),
    status: order.status,
    placedAt: isoDateOrFallback(order.placedAt),
    deliveryEstimate: order.deliveryEstimate,
    trackingCode: order.trackingCode ?? undefined,
    review: await reviewForOrder(order.id),
  };
}

function notificationFor(row: typeof notificationsTable.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    productId: row.productId,
    conversationId: row.conversationId,
    offerId: row.offerId,
    orderId: row.orderId,
    createdAt: isoDateOrFallback(row.createdAt),
    readAt: row.readAt ? isoDateOrFallback(row.readAt) : null,
  };
}

async function productsFor(params: { search?: string; category?: string; sort?: string; limit?: number; pickup?: boolean; latitudeE6?: number; longitudeE6?: number; radiusKm?: number }) {
  const filters = [];
  if (params.search) {
    filters.push(or(ilike(productsTable.title, `%${params.search}%`), ilike(productsTable.description, `%${params.search}%`)));
  }
  if (params.category) {
    filters.push(eq(productsTable.category, params.category));
  }
  if (params.pickup) filters.push(eq(productsTable.pickupAvailable, true));
  // Coarse bounding box only: coordinates are stored at roughly 0.1 m precision but never returned.
  if (params.latitudeE6 !== undefined && params.longitudeE6 !== undefined && params.radiusKm) {
    const delta = Math.ceil((params.radiusKm / 111) * 1_000_000);
    filters.push(sql`${productsTable.latitudeE6} between ${params.latitudeE6 - delta} and ${params.latitudeE6 + delta}`);
    filters.push(sql`${productsTable.longitudeE6} between ${params.longitudeE6 - delta} and ${params.longitudeE6 + delta}`);
  }

  let query = db.select().from(productsTable);
  if (filters.length > 0) {
    query = query.where(and(...filters)) as typeof query;
  }
  if (params.sort === "price_low") {
    query = query.orderBy(asc(productsTable.price)) as typeof query;
  } else if (params.sort === "price_high") {
    query = query.orderBy(desc(productsTable.price)) as typeof query;
  } else {
    query = query.orderBy(desc(productsTable.createdAt)) as typeof query;
  }

  const rows = await query.limit(params.limit ?? 20);
  return Promise.all(rows.map(productFor));
}

router.get("/products", async (req, res) => {
  const items = await productsFor({
    search: queryString(req.query.search),
    category: queryString(req.query.category),
    sort: queryString(req.query.sort),
    limit: Number(req.query.limit) || 20,
    pickup: req.query.pickup === "true",
    latitudeE6: Number.isInteger(Number(req.query.latitudeE6)) ? Number(req.query.latitudeE6) : undefined,
    longitudeE6: Number.isInteger(Number(req.query.longitudeE6)) ? Number(req.query.longitudeE6) : undefined,
    radiusKm: Math.min(100, Math.max(1, Number(req.query.radiusKm) || 20)),
  });
  res.json({ items, total: items.length });
});

router.get("/products/:productId", async (req, res) => {
  const rows = await db.select().from(productsTable).where(eq(productsTable.id, pathParam(req.params.productId))).limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: "Listing not found" });
    return;
  }
  res.json(await productFor(rows[0]));
});

router.get("/home", async (_req, res) => {
  const items = await productsFor({ limit: 20 });
  const categoryRows = await db
    .select({ category: productsTable.category, count: sql<number>`count(*)` })
    .from(productsTable)
    .groupBy(productsTable.category)
    .orderBy(desc(sql`count(*)`));
  const liveCounts = new Map(categoryRows.map((row) => [row.category, { count: Number(row.count), image: items.find((item) => item.category === row.category)?.images[0] }]));
  res.json({
    featured: items.slice(0, 3),
    recommended: items.slice(1),
    categories: homeCategories.map((category) => ({
      ...category,
      count: liveCounts.get(category.name)?.count ?? 0,
      image: liveCounts.get(category.name)?.image,
    })),
  });
});

router.post("/products", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const idempotencyKey = req.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    res.status(400).json({ error: "A valid Idempotency-Key is required" });
    return;
  }
  const listingId = `listing_${createHash("sha256").update(`${userId}:${idempotencyKey}`).digest("hex").slice(0, 24)}`;
  const existing = (await db.select().from(productsTable).where(eq(productsTable.id, listingId)).limit(1))[0];
  if (existing) {
    res.status(200).json(await productFor(existing));
    return;
  }
  const body = req.body as Partial<{
    title: string;
    price: number;
    condition: string;
    category: string;
    description: string;
    location: string;
    images: string[];
    pickupAvailable: boolean;
    pickupArea: string;
    latitudeE6: number;
    longitudeE6: number;
    sellerAvailability: string[];
    keywords: string[];
  }>;
  if (!body.title || !body.price || !body.condition || !body.category || !body.description || !body.location || !body.images?.length) {
    res.status(400).json({ error: "Title, price, condition, category, description, location and images are required" });
    return;
  }
  const imageChecks = await Promise.all(body.images.map((image) => validateStoredImageUrl(image, userId)));
  if (imageChecks.some((valid) => !valid)) {
    res.status(400).json({ error: "Every listing photo must be an uploaded JPEG, PNG, or WebP image" });
    return;
  }
  const listing = {
    id: listingId,
    sellerId: userId,
    title: body.title,
    price: String(body.price),
    currency: "GBP",
    condition: body.condition,
    category: body.category,
    description: body.description,
    location: body.location,
    images: [...body.images],
    pickupAvailable: body.pickupAvailable === true,
    pickupArea: typeof body.pickupArea === "string" ? body.pickupArea.slice(0, 120) : null,
    latitudeE6: Number.isInteger(body.latitudeE6) ? body.latitudeE6 : null,
    longitudeE6: Number.isInteger(body.longitudeE6) ? body.longitudeE6 : null,
    sellerAvailability: Array.isArray(body.sellerAvailability) ? body.sellerAvailability.filter((v): v is string => typeof v === "string").slice(0, 14) : [],
    keywords: Array.isArray(body.keywords) ? body.keywords.filter((v): v is string => typeof v === "string").slice(0, 12) : [],
    favouriteCount: 0,
  };
  try {
    const rows = await db.insert(productsTable).values(listing).returning();
    res.status(201).json(await productFor(rows[0]));
  } catch (error) {
    if (idempotencyKey) {
      const existing = await db.select().from(productsTable).where(eq(productsTable.id, listing.id)).limit(1);
      if (existing[0]) {
        res.status(200).json(await productFor(existing[0]));
        return;
      }
    }
    throw error;
  }
});

router.get("/users/:userId", async (req, res) => {
  const profile = await profileFor(pathParam(req.params.userId));
  if (!profile) {
    res.status(404).json({ error: "Seller profile not found" });
    return;
  }
  res.json(profile);
});

router.get("/me", requireAuth, async (req, res) => {
  const profile = await profileFor((req as AuthedRequest).userId as string);
  if (!profile) {
    res.status(500).json({ error: "Could not provision marketplace profile" });
    return;
  }
  res.json(profile);
});

router.put("/me", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const name = queryString(req.body?.name);
  const avatar = typeof req.body?.avatar === "string" ? req.body.avatar.trim() : "";
  if (!name || name.length > 120 || avatar.length > 2_000) {
    res.status(400).json({ error: "A valid profile name is required" });
    return;
  }
  await db.update(usersTable).set({ name, avatar }).where(eq(usersTable.id, userId));
  const profile = await profileFor(userId);
  res.json(profile);
});

router.get("/favourites", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const rows = await db
    .select({ product: productsTable })
    .from(favouritesTable)
    .innerJoin(productsTable, eq(favouritesTable.productId, productsTable.id))
    .where(eq(favouritesTable.userId, userId));
  const items = await Promise.all(rows.map((row) => productFor(row.product)));
  res.json({ items, total: items.length });
});

router.post("/favourites/:productId", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const productId = pathParam(req.params.productId);
  const products = await db.select().from(productsTable).where(eq(productsTable.id, productId)).limit(1);
  if (!products[0]) {
    res.status(404).json({ error: "Listing not found" });
    return;
  }
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(favouritesTable)
      .values({ userId, productId })
      .onConflictDoNothing()
      .returning({ productId: favouritesTable.productId });
    if (inserted.length) {
      await tx.update(productsTable).set({ favouriteCount: sql`${productsTable.favouriteCount} + 1` }).where(eq(productsTable.id, productId));
      if (products[0].sellerId !== userId) {
        await tx.insert(notificationsTable).values({
          id: id("notification"),
          recipientUserId: products[0].sellerId,
          type: "favourite",
          title: "Someone saved your listing",
          body: `${(await profileFor(userId))?.name ?? "A LumaLoop member"} saved ${products[0].title}.`,
          productId,
        });
      }
    }
  });
  res.status(204).send();
});

router.delete("/favourites/:productId", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const productId = pathParam(req.params.productId);
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(favouritesTable)
      .where(and(eq(favouritesTable.userId, userId), eq(favouritesTable.productId, productId)))
      .returning({ productId: favouritesTable.productId });
    if (deleted.length) {
      await tx.update(productsTable).set({ favouriteCount: sql`greatest(${productsTable.favouriteCount} - 1, 0)` }).where(eq(productsTable.id, productId));
    }
  });
  res.status(204).send();
});

router.post("/offers", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const productId = queryString(req.body?.productId);
  const amount = Number(req.body?.amount);
  if (!productId || !amount || amount <= 0) {
    res.status(400).json({ error: "A product and valid amount are required" });
    return;
  }
  const products = await db.select().from(productsTable).where(eq(productsTable.id, productId)).limit(1);
  if (!products[0]) {
    res.status(404).json({ error: "Listing not found" });
    return;
  }
  const rows = await db.transaction(async (tx) => {
    const inserted = await tx.insert(offersTable).values({ id: id("offer"), productId, fromUserId: userId, amount: String(amount) }).returning();
    if (products[0].sellerId !== userId) {
      await tx.insert(notificationsTable).values({
        id: id("notification"),
        recipientUserId: products[0].sellerId,
        type: "offer",
        title: "New offer on your listing",
        body: `${(await profileFor(userId))?.name ?? "A LumaLoop member"} offered £${amount.toFixed(2)} for ${products[0].title}.`,
        productId,
        offerId: inserted[0].id,
      });
    }
    return inserted;
  });
  res.status(201).json({
    id: rows[0].id,
    productId,
    productTitle: products[0].title,
    amount,
    status: rows[0].status,
    fromUser: await profileFor(userId),
    createdAt: new Date(rows[0].createdAt).toISOString(),
  });
});

router.get("/offers/mine", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const rows = await db
    .select({ offer: offersTable, product: productsTable })
    .from(offersTable)
    .innerJoin(productsTable, eq(offersTable.productId, productsTable.id))
    .where(eq(offersTable.fromUserId, userId))
    .orderBy(desc(offersTable.createdAt));
  res.json(await Promise.all(rows.map(async ({ offer, product }) => ({
    id: offer.id,
    productId: product.id,
    productTitle: product.title,
    amount: Number(offer.amount),
    status: offer.status,
    fromUser: await profileFor(offer.fromUserId),
    createdAt: new Date(offer.createdAt).toISOString(),
  }))));
});

router.get("/orders", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const rows = await db
    .select({ order: ordersTable, product: productsTable })
    .from(ordersTable)
    .innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
    .where(eq(ordersTable.buyerId, userId))
    .orderBy(desc(ordersTable.placedAt));
  res.json(await Promise.all(rows.map(({ order, product }) => orderPayload(order, product))));
});

router.get("/orders/sales", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const rows = await db
    .select({ order: ordersTable, product: productsTable })
    .from(ordersTable)
    .innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
    .where(eq(productsTable.sellerId, userId))
    .orderBy(desc(ordersTable.placedAt));
  res.json(await Promise.all(rows.map(({ order, product }) => orderPayload(order, product))));
});

router.post("/orders/:orderId/review", requireAuth, async (req, res): Promise<void> => {
  const userId = (req as AuthedRequest).userId as string;
  const orderId = pathParam(req.params.orderId);
  const body = {
    rating: req.body?.rating,
    body: typeof req.body?.body === "string" ? req.body.body.trim() : req.body?.body,
  };
  const parsed = typeof body.rating === "number" && Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5
    && typeof body.body === "string" && body.body.length >= 1 && body.body.length <= 1000
    ? { rating: body.rating, body: body.body } : null;
  if (!parsed) {
    res.status(400).json({ error: "Choose a whole-number rating from 1 to 5 and write a review." });
    return;
  }

  const rows = await db
    .select({ order: ordersTable, product: productsTable })
    .from(ordersTable)
    .innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
    .where(and(eq(ordersTable.id, orderId), eq(ordersTable.buyerId, userId)))
    .limit(1);
  const purchase = rows[0];
  if (!purchase) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (purchase.order.status !== "delivered") {
    res.status(400).json({ error: "Reviews are available after an order is delivered." });
    return;
  }
  if (purchase.product.sellerId === userId) {
    res.status(403).json({ error: "You cannot review your own listing." });
    return;
  }

  const existing = await db.select({ id: reviewsTable.id }).from(reviewsTable).where(eq(reviewsTable.orderId, orderId)).limit(1);
  if (existing[0]) {
    res.status(409).json({ error: "This order has already been reviewed." });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select ${usersTable.id} from ${usersTable} where ${usersTable.id} = ${purchase.product.sellerId} for update`);
      await tx.insert(reviewsTable).values({
        id: id("review"),
        orderId,
        sellerId: purchase.product.sellerId,
        buyerId: userId,
        rating: parsed.rating,
        body: parsed.body,
      });
      const aggregate = await tx
        .select({
          average: sql<string>`avg(${reviewsTable.rating})`,
          count: sql<string>`count(*)`,
        })
        .from(reviewsTable)
        .where(eq(reviewsTable.sellerId, purchase.product.sellerId));
      await tx.update(usersTable).set({
        rating: Number(aggregate[0]?.average ?? 0).toFixed(2),
        reviewCount: Number(aggregate[0]?.count ?? 0),
      }).where(eq(usersTable.id, purchase.product.sellerId));
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      res.status(409).json({ error: "This order has already been reviewed." });
      return;
    }
    throw error;
  }

  const created = await db
    .select({ review: reviewsTable, reviewer: usersTable, product: productsTable })
    .from(reviewsTable)
    .innerJoin(usersTable, eq(reviewsTable.buyerId, usersTable.id))
    .innerJoin(ordersTable, eq(reviewsTable.orderId, ordersTable.id))
    .innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
    .where(eq(reviewsTable.orderId, orderId))
    .limit(1);
  if (!created[0]) {
    res.status(500).json({ error: "Review could not be loaded after creation." });
    return;
  }
  res.status(201).json(reviewPayload(created[0]));
});

router.post("/orders", requireAuth, async (req, res) => {
  // Kept for clients generated against the legacy operation. Orders are created
  // exclusively by the verified Stripe Checkout webhook projector.
  res.status(409).json({ error: "Direct order creation is disabled. Complete Stripe Checkout to create an order." });
});

router.patch("/orders/:orderId/status", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const orderId = pathParam(req.params.orderId);
  const status = queryString(req.body?.status);
  const trackingCode = typeof req.body?.trackingCode === "string" ? req.body.trackingCode.trim() : undefined;
  const deliveryEstimate = typeof req.body?.deliveryEstimate === "string" ? req.body.deliveryEstimate.trim() : undefined;
  const allowedStatuses = ["packed", "shipped", "cancelled"];
  if (!status || !allowedStatuses.includes(status)) {
    res.status(400).json({ error: "A valid order status is required" });
    return;
  }
  const order = await db
    .select({ order: ordersTable, product: productsTable })
    .from(ordersTable)
    .innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
    .where(and(eq(ordersTable.id, orderId), eq(productsTable.sellerId, userId)))
    .limit(1);
  if (!order[0]) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  const currentStatus = order[0].order.status;
  const expectedPrevious = status === "packed" ? "paid" : status === "shipped" ? "packed" : ["paid", "packed"].includes(currentStatus) ? currentStatus : null;
  if (!expectedPrevious) {
    res.status(409).json({ error: "Sellers may progress orders from paid → packed → shipped only. Cancellation is only available before shipment." });
    return;
  }
  const updated = await db.transaction(async (tx) => {
    const [next] = await tx.update(ordersTable).set({
      status,
      ...(trackingCode !== undefined ? { trackingCode: trackingCode || null } : {}),
      ...(deliveryEstimate !== undefined && deliveryEstimate ? { deliveryEstimate } : {}),
    }).where(and(eq(ordersTable.id, orderId), eq(ordersTable.status, expectedPrevious))).returning();
    if (!next) return null;
    if (next.status !== currentStatus) {
      if (next.status === "cancelled") {
        await tx.update(payoutLedgerTable).set({
          status: "cancelled",
          availableAt: null,
        }).where(and(eq(payoutLedgerTable.orderId, next.id), eq(payoutLedgerTable.status, "pending")));
      }
      await tx.insert(notificationsTable).values({
        id: id("notification"),
        recipientUserId: next.buyerId,
        type: "delivery",
        title: "Delivery update",
        body: `${order[0].product.title} is now ${status}.`,
        productId: next.productId,
        orderId: next.id,
      });
    }
    return next;
  });
  if (!updated) {
    res.status(409).json({ error: "This order changed before your update. Refresh and follow the next delivery step." });
    return;
  }
  res.json(await orderPayload(updated, order[0].product));
});

// Delivery confirmation is deliberately buyer-controlled: seller status updates
// can never release ledger funds.
router.post("/orders/:orderId/confirm-delivery", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const orderId = pathParam(req.params.orderId);
  const purchase = await db.select({ order: ordersTable, product: productsTable })
    .from(ordersTable).innerJoin(productsTable, eq(ordersTable.productId, productsTable.id))
    .where(and(eq(ordersTable.id, orderId), eq(ordersTable.buyerId, userId))).limit(1);
  if (!purchase[0]) return void res.status(404).json({ error: "Order not found for this buyer." });
  const delivered = await db.transaction(async (tx) => {
    const [updated] = await tx.update(ordersTable).set({ status: "delivered" })
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.buyerId, userId), eq(ordersTable.status, "shipped"))).returning();
    if (!updated) return null;
    await tx.update(payoutLedgerTable).set({ status: "available", availableAt: new Date() })
      .where(and(eq(payoutLedgerTable.orderId, orderId), eq(payoutLedgerTable.status, "pending")));
    await tx.insert(notificationsTable).values({
      id: id("notification"), recipientUserId: purchase[0].product.sellerId, type: "payout",
      title: "Delivery confirmed", body: `${purchase[0].product.title} was confirmed delivered and its funds are now available.`, productId: updated.productId, orderId,
    });
    return updated;
  });
  if (!delivered) return void res.status(409).json({ error: "Only a shipped order can be confirmed delivered, and this order may have changed." });
  res.json(await orderPayload(delivered, purchase[0].product));
});

router.get("/conversations", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const rows = await db
    .select({ conversation: conversationsTable, product: productsTable })
    .from(conversationsTable)
    .innerJoin(productsTable, eq(conversationsTable.productId, productsTable.id))
    .where(or(eq(conversationsTable.buyerId, userId), eq(conversationsTable.sellerId, userId)))
    .orderBy(desc(conversationsTable.updatedAt));
  res.json(await Promise.all(rows.map(async ({ conversation, product }) => {
    const participants = conversation.buyerId === userId ? conversation.sellerId : conversation.buyerId;
    const latest = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, conversation.id)).orderBy(desc(messagesTable.createdAt)).limit(1);
    return {
      id: conversation.id,
      participant: await profileFor(participants),
      productTitle: product.title,
      lastMessage: latest[0]?.body ?? "Start the conversation",
      updatedAt: new Date(conversation.updatedAt).toISOString(),
      unreadCount: conversation.unreadCount,
    };
  })));
});

router.get("/conversations/:conversationId/messages", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const conversationId = pathParam(req.params.conversationId);
  const conversation = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.id, conversationId),
      or(eq(conversationsTable.buyerId, userId), eq(conversationsTable.sellerId, userId)),
    ))
    .limit(1);
  if (!conversation[0]) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const rows = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, conversationId)).orderBy(asc(messagesTable.createdAt));
  res.json(rows.map((message) => ({
    id: message.id,
    conversationId: message.conversationId,
    body: message.body,
    senderId: message.senderId,
    createdAt: new Date(message.createdAt).toISOString(),
  })));
});

router.post("/conversations/:conversationId/messages", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const body = queryString(req.body?.body);
  if (!body) {
    res.status(400).json({ error: "Message body is required" });
    return;
  }
  const conversationId = pathParam(req.params.conversationId);
  const conversation = await db
    .select()
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.id, conversationId),
      or(eq(conversationsTable.buyerId, userId), eq(conversationsTable.sellerId, userId)),
    ))
    .limit(1);
  if (!conversation[0]) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const rows = await db.transaction(async (tx) => {
    const inserted = await tx.insert(messagesTable).values({
      id: id("message"),
      conversationId,
      senderId: userId,
      body,
    }).returning();
    const recipientUserId = conversation[0].buyerId === userId ? conversation[0].sellerId : conversation[0].buyerId;
    await tx.update(conversationsTable).set({
      updatedAt: new Date(),
      unreadCount: sql`${conversationsTable.unreadCount} + 1`,
    }).where(eq(conversationsTable.id, conversationId));
    await tx.insert(notificationsTable).values({
      id: id("notification"),
      recipientUserId,
      type: "message",
      title: "New message",
      body: `You have a new message about your listing.`,
      productId: conversation[0].productId,
      conversationId,
    });
    return inserted;
  });
  res.status(201).json({
    id: rows[0].id,
    conversationId: rows[0].conversationId,
    body: rows[0].body,
    senderId: rows[0].senderId,
    createdAt: new Date(rows[0].createdAt).toISOString(),
  });
});

router.get("/notifications", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const rows = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.recipientUserId, userId))
    .orderBy(desc(notificationsTable.createdAt));
  res.json(rows.map(notificationFor));
});

router.patch("/notifications/:notificationId/read", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const notificationId = pathParam(req.params.notificationId);
  const rows = await db.update(notificationsTable)
    .set({ readAt: new Date() })
    .where(and(eq(notificationsTable.id, notificationId), eq(notificationsTable.recipientUserId, userId)))
    .returning();
  if (!rows[0]) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }
  res.json(notificationFor(rows[0]));
});

router.patch("/notifications/read-all", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const rows = await db.update(notificationsTable)
    .set({ readAt: new Date() })
    .where(and(eq(notificationsTable.recipientUserId, userId), sql`${notificationsTable.readAt} is null`))
    .returning({ id: notificationsTable.id });
  res.json({ updated: rows.length });
});

router.post("/reports", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).userId as string;
  const targetType = queryString(req.body?.targetType);
  const targetId = queryString(req.body?.targetId);
  const reason = queryString(req.body?.reason);
  if (!targetType || !targetId || !reason) {
    res.status(400).json({ error: "Target and reason are required" });
    return;
  }
  const rows = await db.insert(reportsTable).values({
    id: id("report"),
    reporterId: userId,
    targetType,
    targetId,
    reason,
  }).returning();
  res.status(201).json({
    id: rows[0].id,
    targetType: rows[0].targetType,
    targetId: rows[0].targetId,
    reason: rows[0].reason,
    status: rows[0].status,
    createdAt: new Date(rows[0].createdAt).toISOString(),
  });
});

async function adminReportFor(report: typeof reportsTable.$inferSelect) {
  const auditRows = await db
    .select()
    .from(moderationAuditTable)
    .where(eq(moderationAuditTable.reportId, report.id))
    .orderBy(asc(moderationAuditTable.createdAt));
  return {
    id: report.id,
    reporterId: report.reporterId,
    targetType: report.targetType,
    targetId: report.targetId,
    reason: report.reason,
    status: report.status,
    createdAt: new Date(report.createdAt).toISOString(),
    resolvedBy: report.resolvedBy,
    resolvedAt: report.resolvedAt ? new Date(report.resolvedAt).toISOString() : null,
    audit: auditRows.map((entry) => ({
      id: entry.id,
      moderatorId: entry.moderatorId,
      action: entry.action,
      previousStatus: entry.previousStatus,
      newStatus: entry.newStatus,
      createdAt: new Date(entry.createdAt).toISOString(),
    })),
  };
}

router.get("/admin/overview", requireAdmin, async (_req, res) => {
  const [users, listings, reports, orders, openReports] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(usersTable),
    db.select({ count: sql<number>`count(*)` }).from(productsTable),
    db.select({ count: sql<number>`count(*)` }).from(reportsTable),
    db.select({ count: sql<number>`count(*)` }).from(ordersTable),
    db.select({ count: sql<number>`count(*)` }).from(reportsTable).where(eq(reportsTable.status, "open")),
  ]);
  res.json({
    counts: {
      users: Number(users[0]?.count ?? 0),
      listings: Number(listings[0]?.count ?? 0),
      reports: Number(reports[0]?.count ?? 0),
      orders: Number(orders[0]?.count ?? 0),
      openReports: Number(openReports[0]?.count ?? 0),
    },
  });
});

router.get("/admin/reports", requireAdmin, async (req, res) => {
  const status = queryString(req.query.status);
  const rows = await db
    .select()
    .from(reportsTable)
    .where(status ? eq(reportsTable.status, status) : undefined)
    .orderBy(desc(reportsTable.createdAt));
  res.json(await Promise.all(rows.map(adminReportFor)));
});

router.patch("/admin/reports/:reportId", requireAdmin, async (req, res) => {
  const reportId = pathParam(req.params.reportId);
  const status = queryString(req.body?.status);
  const allowedStatuses = ["open", "reviewing", "resolved", "dismissed"];
  if (!status || !allowedStatuses.includes(status)) {
    res.status(400).json({ error: "A valid report status is required" });
    return;
  }
  const moderatorId = (req as AuthedRequest).userId as string;
  const report = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(reportsTable)
      .where(eq(reportsTable.id, reportId))
      .limit(1)
      .for("update");
    if (!existing[0]) return null;
    if (existing[0].status === status) return existing[0];
    const resolved = status === "resolved" || status === "dismissed";
    const [updated] = await tx.update(reportsTable).set({
      status,
      resolvedBy: resolved ? moderatorId : null,
      resolvedAt: resolved ? new Date() : null,
    }).where(eq(reportsTable.id, reportId)).returning();
    await tx.insert(moderationAuditTable).values({
      id: id("audit"),
      reportId,
      moderatorId,
      action: "status_changed",
      previousStatus: existing[0].status,
      newStatus: status,
    });
    return updated;
  });
  if (!report) {
    res.status(404).json({ error: "Report not found" });
    return;
  }
  res.json(await adminReportFor(report));
});

export default router;