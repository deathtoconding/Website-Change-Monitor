import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DiffLine } from "../../lib/types.js";

export const monitorFrequencyEnum = pgEnum("monitor_frequency", [
  "hourly",
  "six-hourly",
  "daily",
]);
export const monitorStatusEnum = pgEnum("monitor_status", [
  "active",
  "paused",
  "error",
  "deleted",
]);
export const planEnum = pgEnum("plan", ["free", "starter", "business"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
]);
export const tokenPurposeEnum = pgEnum("token_purpose", [
  "email_verification",
  "password_reset",
]);
export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "sent",
  "failed",
  "not_configured",
]);
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "sent",
  "failed",
  "not_configured",
]);
export const systemNotificationStatusEnum = pgEnum(
  "system_notification_status",
  ["pending", "sent", "failed", "not_configured", "skipped"],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    stripeCustomerId: text("stripe_customer_id"),
    sessionVersion: integer("session_version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
    stripeCustomerUnique: uniqueIndex("users_stripe_customer_unique").on(
      table.stripeCustomerId,
    ),
  }),
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: tokenPurposeEnum("purpose").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("verification_tokens_hash_unique").on(
      table.tokenHash,
    ),
    userPurposeIdx: index("verification_tokens_user_purpose_idx").on(
      table.userId,
      table.purpose,
    ),
  }),
);

export const monitors = pgTable(
  "monitors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    frequency: monitorFrequencyEnum("frequency").notNull().default("daily"),
    status: monitorStatusEnum("status").notNull().default("active"),
    selector: text("selector").notNull().default(""),
    currentHash: text("current_hash"),
    currentSnapshotId: uuid("current_snapshot_id"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userStatusIdx: index("monitors_user_status_idx").on(
      table.userId,
      table.status,
    ),
    nextCheckIdx: index("monitors_next_check_idx").on(table.nextCheckAt),
    userUrlIdx: index("monitors_user_url_idx").on(table.userId, table.url),
  }),
);

export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    httpStatus: integer("http_status").notNull(),
    contentType: text("content_type").notNull(),
    responseTimeMs: integer("response_time_ms").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    monitorFetchedIdx: index("snapshots_monitor_fetched_idx").on(
      table.monitorId,
      table.fetchedAt,
    ),
    fetchedAtIdx: index("snapshots_fetched_at_idx").on(table.fetchedAt),
    monitorHashIdx: index("snapshots_monitor_hash_idx").on(
      table.monitorId,
      table.contentHash,
    ),
  }),
);

export const changes = pgTable(
  "changes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    previousSnapshotId: uuid("previous_snapshot_id").references(
      () => snapshots.id,
      { onDelete: "set null" },
    ),
    newSnapshotId: uuid("new_snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    diff: jsonb("diff").$type<DiffLine[]>().notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    notificationStatus: notificationStatusEnum("notification_status")
      .notNull()
      .default("pending"),
  },
  (table) => ({
    monitorDetectedIdx: index("changes_monitor_detected_idx").on(
      table.monitorId,
      table.detectedAt,
    ),
    snapshotUnique: uniqueIndex("changes_new_snapshot_unique").on(
      table.newSnapshotId,
    ),
  }),
);

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    changeId: uuid("change_id")
      .notNull()
      .references(() => changes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientEmail: text("recipient_email").notNull(),
    status: outboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    providerMessageId: text("provider_message_id"),
    lastErrorCode: text("last_error_code"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    changeUnique: uniqueIndex("notification_outbox_change_unique").on(
      table.changeId,
    ),
    pendingIdx: index("notification_outbox_pending_idx").on(
      table.status,
      table.createdAt,
    ),
  }),
);

export const systemNotificationKindEnum = pgEnum("system_notification_kind", [
  "failure",
  "weekly_digest",
]);

export type FailureNotificationPayload = {
  monitorName: string;
  url: string;
  monitorId: string;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  occurredAt: string;
};

export type WeeklyDigestNotificationPayload = {
  periodStart: string;
  periodEnd: string;
  changes: {
    changeId: string;
    monitorName: string;
    url: string;
    detectedAt: string;
    addedCount: number;
    removedCount: number;
  }[];
};

export type SystemNotificationPayload =
  FailureNotificationPayload | WeeklyDigestNotificationPayload;

export const systemNotificationOutbox = pgTable(
  "system_notification_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    monitorId: uuid("monitor_id").references(() => monitors.id, {
      onDelete: "cascade",
    }),
    kind: systemNotificationKindEnum("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    payload: jsonb("payload").$type<SystemNotificationPayload>().notNull(),
    status: systemNotificationStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    providerMessageId: text("provider_message_id"),
    lastErrorCode: text("last_error_code"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dedupeUnique: uniqueIndex("system_notification_outbox_dedupe_unique").on(
      table.dedupeKey,
    ),
    pendingIdx: index("system_notification_outbox_pending_idx").on(
      table.status,
      table.createdAt,
    ),
    userIdx: index("system_notification_outbox_user_idx").on(
      table.userId,
      table.createdAt,
    ),
  }),
);

export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  emailAlerts: boolean("email_alerts").notNull().default(true),
  weeklyDigest: boolean("weekly_digest").notNull().default(false),
  failureAlerts: boolean("failure_alerts").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id"),
    plan: planEnum("plan").notNull().default("free"),
    status: subscriptionStatusEnum("status").notNull().default("incomplete"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("subscriptions_user_idx").on(table.userId, table.status),
    stripeSubscriptionUnique: uniqueIndex(
      "subscriptions_stripe_subscription_unique",
    ).on(table.stripeSubscriptionId),
  }),
);

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
export type MonitorRow = typeof monitors.$inferSelect;
export type SnapshotRow = typeof snapshots.$inferSelect;
export type ChangeRow = typeof changes.$inferSelect;
