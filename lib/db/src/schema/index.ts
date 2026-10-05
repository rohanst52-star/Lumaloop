import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable("marketplace_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  avatar: text("avatar").notNull(),
  location: text("location").notNull(),
  bio: text("bio").notNull().default(""),
  rating: numeric("rating", { precision: 3, scale: 2 }).notNull().default("5"),
  reviewCount: integer("review_count").notNull().default(0),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  isAdmin: boolean("is_admin").notNull().default(false),
});

export const productsTable = pgTable("marketplace_products", {
  id: text("id").primaryKey(),
  sellerId: text("seller_id").notNull().references(() => usersTable.id),
  title: text("title").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("GBP"),
  condition: text("condition").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),
  location: text("location").notNull(),
  images: jsonb("images").$type<string[]>().notNull(),
  favouriteCount: integer("favourite_count").notNull().default(0),
  isSold: boolean("is_sold").notNull().default(false),
  checkoutReservationId: text("checkout_reservation_id"),
  checkoutReservedAt: timestamp("checkout_reserved_at", { withTimezone: true }),
  pickupAvailable: boolean("pickup_available").notNull().default(false),
  pickupArea: text("pickup_area"),
  latitudeE6: integer("latitude_e6"),
  longitudeE6: integer("longitude_e6"),
  sellerAvailability: jsonb("seller_availability").$type<string[]>().notNull().default([]),
  keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const favouritesTable = pgTable(
  "marketplace_favourites",
  {
    userId: text("user_id").notNull().references(() => usersTable.id),
    productId: text("product_id").notNull().references(() => productsTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.productId] })],
);

export const offersTable = pgTable("marketplace_offers", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => productsTable.id),
  fromUserId: text("from_user_id").notNull().references(() => usersTable.id),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ordersTable = pgTable("marketplace_orders", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => productsTable.id),
  buyerId: text("buyer_id").notNull().references(() => usersTable.id),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  buyerProtectionFee: numeric("buyer_protection_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  status: text("status").notNull().default("paid"),
  trackingCode: text("tracking_code"),
  deliveryEstimate: text("delivery_estimate").notNull(),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("marketplace_orders_checkout_session_idx").on(table.stripeCheckoutSessionId),
  // A listing can be fulfilled only once, including across distinct Checkout sessions.
  uniqueIndex("marketplace_orders_product_idx").on(table.productId),
]);

/** Application payment intent records; Stripe remains the source of truth for payments. */
export const checkoutRecordsTable = pgTable("marketplace_checkout_records", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id),
  productId: text("product_id").references(() => productsTable.id),
  boostId: text("boost_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  listingAmount: numeric("listing_amount", { precision: 10, scale: 2 }),
  buyerProtectionFee: numeric("buyer_protection_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull().default("created"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("marketplace_checkout_session_idx").on(table.stripeCheckoutSessionId),
  uniqueIndex("marketplace_checkout_idempotency_idx").on(table.userId, table.idempotencyKey),
]);

/** Immutable receipt of Stripe events already projected into marketplace state. */
export const stripeEventRecordsTable = pgTable("marketplace_stripe_events", {
  stripeEventId: text("stripe_event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  checkoutSessionId: text("checkout_session_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Server-owned seller accounting entries. These are created from verified
 * orders and are the only source used by the balance endpoint.
 */
export const payoutLedgerTable = pgTable("marketplace_payout_ledger", {
  id: text("id").primaryKey(),
  sellerId: text("seller_id").notNull().references(() => usersTable.id),
  orderId: text("order_id").notNull().references(() => ordersTable.id),
  grossAmount: numeric("gross_amount", { precision: 10, scale: 2 }).notNull(),
  platformFee: numeric("platform_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  netAmount: numeric("net_amount", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull().default("pending"),
  withdrawalId: text("withdrawal_id"),
  availableAt: timestamp("available_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("marketplace_payout_ledger_order_idx").on(table.orderId),
  index("marketplace_payout_ledger_seller_status_idx").on(table.sellerId, table.status),
]);

/** Server-confirmed requests to move released seller funds out of the ledger. */
export const withdrawalsTable = pgTable("marketplace_withdrawals", {
  id: text("id").primaryKey(),
  sellerId: text("seller_id").notNull().references(() => usersTable.id),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull().default("reserved"),
  idempotencyKey: text("idempotency_key").notNull(),
  provider: text("provider").notNull().default("stripe"),
  providerTransferId: text("provider_transfer_id"),
  failureReason: text("failure_reason"),
  reversedAmount: numeric("reversed_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("marketplace_withdrawals_seller_idempotency_idx").on(table.sellerId, table.idempotencyKey),
  index("marketplace_withdrawals_seller_created_idx").on(table.sellerId, table.createdAt),
]);

export const boostsTable = pgTable("marketplace_boosts", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => productsTable.id),
  sellerId: text("seller_id").notNull().references(() => usersTable.id),
  tier: text("tier").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  status: text("status").notNull().default("pending_payment"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
});

/** One Stripe Connect Express destination per seller. Account state is webhook-reconciled. */
export const sellerPayoutAccountsTable = pgTable("marketplace_seller_payout_accounts", {
  sellerId: text("seller_id").primaryKey().references(() => usersTable.id),
  provider: text("provider").notNull().default("stripe"),
  providerAccountId: text("provider_account_id").notNull(),
  status: text("status").notNull().default("pending"),
  chargesEnabled: boolean("charges_enabled").notNull().default(false),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
  detailsSubmitted: boolean("details_submitted").notNull().default(false),
  disabledReason: text("disabled_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("marketplace_seller_payout_provider_account_idx").on(table.providerAccountId)]);

export const protectionCasesTable = pgTable("marketplace_protection_cases", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => ordersTable.id),
  buyerId: text("buyer_id").notNull().references(() => usersTable.id),
  reason: text("reason").notNull(),
  details: text("details").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [index("marketplace_protection_cases_order_idx").on(table.orderId)]);

export const reviewsTable = pgTable(
  "marketplace_reviews",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ordersTable.id),
    sellerId: text("seller_id").notNull().references(() => usersTable.id),
    buyerId: text("buyer_id").notNull().references(() => usersTable.id),
    rating: integer("rating").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("marketplace_reviews_order_idx").on(table.orderId),
    index("marketplace_reviews_seller_created_idx").on(table.sellerId, table.createdAt),
  ],
);

export const conversationsTable = pgTable("marketplace_conversations", {
  id: text("id").primaryKey(),
  buyerId: text("buyer_id").notNull().references(() => usersTable.id),
  sellerId: text("seller_id").notNull().references(() => usersTable.id),
  productId: text("product_id").notNull().references(() => productsTable.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  unreadCount: integer("unread_count").notNull().default(0),
});

export const messagesTable = pgTable("marketplace_messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversationsTable.id),
  senderId: text("sender_id").notNull().references(() => usersTable.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reportsTable = pgTable("marketplace_reports", {
  id: text("id").primaryKey(),
  reporterId: text("reporter_id").notNull().references(() => usersTable.id),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedBy: text("resolved_by").references(() => usersTable.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const moderationAuditTable = pgTable("marketplace_moderation_audit", {
  id: text("id").primaryKey(),
  reportId: text("report_id").notNull().references(() => reportsTable.id),
  moderatorId: text("moderator_id").notNull().references(() => usersTable.id),
  action: text("action").notNull(),
  previousStatus: text("previous_status").notNull(),
  newStatus: text("new_status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notificationsTable = pgTable(
  "marketplace_notifications",
  {
    id: text("id").primaryKey(),
    recipientUserId: text("recipient_user_id").notNull().references(() => usersTable.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    productId: text("product_id").references(() => productsTable.id),
    conversationId: text("conversation_id").references(() => conversationsTable.id),
    offerId: text("offer_id").references(() => offersTable.id),
    orderId: text("order_id").references(() => ordersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    index("marketplace_notifications_recipient_created_idx").on(table.recipientUserId, table.createdAt),
  ],
);

export type User = typeof usersTable.$inferSelect;
export type Product = typeof productsTable.$inferSelect;
export type Offer = typeof offersTable.$inferSelect;
export type Order = typeof ordersTable.$inferSelect;
export type Review = typeof reviewsTable.$inferSelect;
export type Notification = typeof notificationsTable.$inferSelect;
export type PayoutLedgerEntry = typeof payoutLedgerTable.$inferSelect;
export type Withdrawal = typeof withdrawalsTable.$inferSelect;