import { and, eq, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { boostsTable, checkoutRecordsTable, notificationsTable, ordersTable, payoutLedgerTable, productsTable, sellerPayoutAccountsTable, stripeEventRecordsTable, withdrawalsTable } from "@workspace/db/schema";
import { getUncachableStripeClient } from "./stripeClient";

const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
type StripeCheckoutEvent = {
  id: string;
  type: string;
  data?: { object?: { id?: string; payment_intent?: string; payment_status?: string; metadata?: Record<string, string>; charges_enabled?: boolean; payouts_enabled?: boolean; details_submitted?: boolean; requirements?: { disabled_reason?: string | null }; amount?: number; amount_reversed?: number } };
};
const completed = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
const failed = new Set(["checkout.session.async_payment_failed", "checkout.session.expired"]);

/**
 * Called only after stripe-replit-sync has verified the Stripe signature. The
 * event receipt table prevents delivery retries and duplicate event types from
 * creating duplicate orders, boosts, or notifications.
 */
export async function projectStripeEvent(event: StripeCheckoutEvent): Promise<void> {
  const sessionId = event.data?.object?.id;
  const successfulCheckout = event.type === "checkout.session.async_payment_succeeded"
    || (event.type === "checkout.session.completed" && event.data?.object?.payment_status === "paid");
  const relevant = successfulCheckout || failed.has(event.type) || event.type === "account.updated" || event.type === "transfer.reversed";
  if (!event.id || !sessionId || !relevant) return;
  let refundPaymentIntent: string | undefined;
  await db.transaction(async (tx) => {
    const received = await tx.insert(stripeEventRecordsTable).values({
      stripeEventId: event.id, eventType: event.type, checkoutSessionId: sessionId,
    }).onConflictDoNothing().returning({ id: stripeEventRecordsTable.stripeEventId });
    if (!received.length) {
      // Event receipts are normally terminal. A paid losing checkout is the
      // exception: its durable refund_pending state must remain retryable on
      // Stripe's duplicate delivery until the idempotent refund succeeds.
      const retry = (await tx.select().from(checkoutRecordsTable)
        .where(and(eq(checkoutRecordsTable.stripeCheckoutSessionId, sessionId), eq(checkoutRecordsTable.status, "refund_pending"))).limit(1))[0];
      if (retry?.stripePaymentIntentId) refundPaymentIntent = retry.stripePaymentIntentId;
      return;
    }
    if (event.type === "account.updated") {
      const object = event.data?.object!;
      await tx.update(sellerPayoutAccountsTable).set({
        chargesEnabled: object.charges_enabled === true,
        payoutsEnabled: object.payouts_enabled === true,
        detailsSubmitted: object.details_submitted === true,
        disabledReason: object.requirements?.disabled_reason ?? null,
        status: object.payouts_enabled ? "active" : object.requirements?.disabled_reason ? "disabled" : "pending",
        updatedAt: new Date(),
      }).where(eq(sellerPayoutAccountsTable.providerAccountId, sessionId));
      return;
    }
    if (event.type === "transfer.reversed") {
      const withdrawalId = event.data?.object?.metadata?.withdrawalId;
      if (!withdrawalId) return;
      const withdrawal = (await tx.select().from(withdrawalsTable).where(and(eq(withdrawalsTable.id, withdrawalId), eq(withdrawalsTable.providerTransferId, sessionId))).limit(1))[0];
      const object = event.data?.object;
      if (!withdrawal || !object || !object.amount || !object.amount_reversed) return;
      if (object.amount_reversed !== object.amount) {
        await tx.update(withdrawalsTable).set({ status: "partially_reversed", reversedAmount: String(object.amount_reversed / 100), failureReason: "Stripe partially reversed this transfer; reconciliation is required." })
          .where(and(eq(withdrawalsTable.id, withdrawalId), or(eq(withdrawalsTable.status, "paid"), eq(withdrawalsTable.status, "partially_reversed"))));
        return;
      }
      const [reversed] = await tx.update(withdrawalsTable).set({
        status: "reversed", reversedAmount: String(object.amount / 100), failureReason: "Stripe reversed the transfer.", completedAt: null,
      }).where(and(eq(withdrawalsTable.id, withdrawalId), or(eq(withdrawalsTable.status, "paid"), eq(withdrawalsTable.status, "partially_reversed")))).returning();
      if (reversed) await tx.update(payoutLedgerTable).set({ status: "available", withdrawalId: null, paidAt: null })
        .where(and(eq(payoutLedgerTable.withdrawalId, reversed.id), eq(payoutLedgerTable.status, "paid_out")));
      return;
    }

    const boost = (await tx.select().from(boostsTable).where(eq(boostsTable.stripeCheckoutSessionId, sessionId)).limit(1))[0];
    if (boost) {
      const nextStatus = completed.has(event.type) ? "active" : "failed";
      const [updated] = await tx.update(boostsTable).set({
        status: nextStatus, ...(nextStatus === "active" ? { activatedAt: new Date() } : {}),
      }).where(and(eq(boostsTable.id, boost.id), eq(boostsTable.status, "pending_payment"))).returning();
      if (updated) await tx.insert(notificationsTable).values({
        id: id("notification"), recipientUserId: boost.sellerId, type: "boost",
        title: nextStatus === "active" ? "Your listing boost is active" : "Your listing boost was not completed",
        body: nextStatus === "active" ? "Your listing is now receiving its selected boost." : "No boost was activated and no listing change was made.",
        productId: boost.productId,
      });
      return;
    }

    const checkout = (await tx.select().from(checkoutRecordsTable).where(eq(checkoutRecordsTable.stripeCheckoutSessionId, sessionId)).limit(1))[0];
    if (!checkout) return;
    if (failed.has(event.type)) {
      const [updated] = await tx.update(checkoutRecordsTable).set({ status: "failed" })
        .where(and(eq(checkoutRecordsTable.id, checkout.id), eq(checkoutRecordsTable.status, "created"))).returning();
      if (updated) await tx.insert(notificationsTable).values({
        id: id("notification"), recipientUserId: checkout.userId, type: "order",
        title: "Checkout was not completed", body: "Your payment was not completed; the listing has not been ordered.", productId: checkout.productId,
      });
      await tx.update(productsTable).set({ checkoutReservationId: null, checkoutReservedAt: null })
        .where(and(eq(productsTable.id, checkout.productId!), eq(productsTable.checkoutReservationId, event.data?.object?.metadata?.reservationId ?? ""), eq(productsTable.isSold, false)));
      return;
    }
    if (!checkout.productId || !checkout.listingAmount) return;
    const product = (await tx.select().from(productsTable).where(eq(productsTable.id, checkout.productId)).limit(1))[0];
    if (!product || product.sellerId === checkout.userId) return; // defense in depth: never fulfil own-listing checkout
    const [order] = await tx.insert(ordersTable).values({
      id: id("order"), productId: product.id, buyerId: checkout.userId,
      amount: checkout.listingAmount, buyerProtectionFee: checkout.buyerProtectionFee,
      stripeCheckoutSessionId: sessionId, deliveryEstimate: product.pickupAvailable ? "Arrange local pickup with the seller" : "Arrives in 2–4 days",
    }).onConflictDoNothing().returning();
    if (!order) {
      // A legacy/racing paid session lost the listing's one-order invariant.
      // Record it rather than aborting webhook receipt, then refund outside
      // the transaction with an event-derived idempotency key.
      await tx.update(checkoutRecordsTable).set({ status: "refund_pending", completedAt: new Date(), stripePaymentIntentId: event.data?.object?.payment_intent ?? null }).where(eq(checkoutRecordsTable.id, checkout.id));
      refundPaymentIntent = event.data?.object?.payment_intent;
      return;
    }
    await tx.update(checkoutRecordsTable).set({ status: "completed", completedAt: new Date(), stripePaymentIntentId: event.data?.object?.payment_intent ?? null }).where(eq(checkoutRecordsTable.id, checkout.id));
    // A successfully inserted order owns the listing even for Checkout
    // sessions created before reservation metadata was introduced.
    await tx.update(productsTable).set({ isSold: true, checkoutReservationId: null, checkoutReservedAt: null })
      .where(eq(productsTable.id, product.id));
    await tx.insert(payoutLedgerTable).values({
      id: id("ledger"),
      sellerId: product.sellerId,
      orderId: order.id,
      grossAmount: checkout.listingAmount,
      platformFee: "0",
      netAmount: checkout.listingAmount,
      status: "pending",
    }).onConflictDoNothing({ target: payoutLedgerTable.orderId });
    await tx.insert(notificationsTable).values([
      { id: id("notification"), recipientUserId: checkout.userId, type: "order", title: "Order confirmed", body: `Your order for ${product.title} is confirmed.`, productId: product.id, orderId: order.id },
      { id: id("notification"), recipientUserId: product.sellerId, type: "order", title: "Your listing sold", body: `${product.title} was purchased and is ready to be prepared.`, productId: product.id, orderId: order.id },
    ]);
  });
  if (refundPaymentIntent) {
    await (await getUncachableStripeClient()).refunds.create({ payment_intent: refundPaymentIntent }, { idempotencyKey: `checkout-conflict:${sessionId}` });
    await db.update(checkoutRecordsTable).set({ status: "refunded" })
      .where(and(eq(checkoutRecordsTable.stripeCheckoutSessionId, sessionId), eq(checkoutRecordsTable.status, "refund_pending")));
  }
}