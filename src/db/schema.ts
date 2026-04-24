import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

export const authTokens = sqliteTable(
  "auth_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    isAdmin: integer("is_admin").notNull().default(0),
    isDisabled: integer("is_disabled").notNull().default(0),
    rpmLimit: integer("rpm_limit"),
    monthlyTokenLimit: integer("monthly_token_limit"),
    lifetimeTokenLimit: integer("lifetime_token_limit"),
    lifetimeTokenUsed: integer("lifetime_token_used").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    createdBy: integer("created_by"),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => ({
    tokenHashUq: uniqueIndex("auth_tokens_token_hash_uq").on(t.tokenHash),
    isDisabledIdx: index("auth_tokens_is_disabled_idx").on(t.isDisabled),
  }),
)

export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authTokenId: integer("auth_token_id"),
    timestamp: integer("timestamp").notNull(),
    endpoint: text("endpoint").notNull(),
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    statusCode: integer("status_code").notNull(),
    latencyMs: integer("latency_ms"),
  },
  (t) => ({
    tokenTsIdx: index("request_logs_token_ts_idx").on(
      t.authTokenId,
      t.timestamp,
    ),
    tsIdx: index("request_logs_ts_idx").on(t.timestamp),
  }),
)

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    authTokenId: integer("auth_token_id"),
    isSuperAdmin: integer("is_super_admin").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
)

export const usageResets = sqliteTable(
  "usage_resets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authTokenId: integer("auth_token_id").notNull(),
    kind: text("kind", { enum: ["monthly", "lifetime"] }).notNull(),
    resetAt: integer("reset_at").notNull(),
  },
  (t) => ({
    tokKindIdx: index("usage_resets_token_kind_idx").on(
      t.authTokenId,
      t.kind,
      t.resetAt,
    ),
  }),
)

// Avoid unused-import lint when sql template not referenced elsewhere

export { sql as _sqlTag } from "drizzle-orm"
