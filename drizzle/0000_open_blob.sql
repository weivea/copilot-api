CREATE TABLE `auth_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`is_admin` integer DEFAULT 0 NOT NULL,
	`is_disabled` integer DEFAULT 0 NOT NULL,
	`rpm_limit` integer,
	`monthly_token_limit` integer,
	`lifetime_token_limit` integer,
	`lifetime_token_used` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` integer,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_token_hash_uq` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_is_disabled_idx` ON `auth_tokens` (`is_disabled`);--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`auth_token_id` integer,
	`timestamp` integer NOT NULL,
	`endpoint` text NOT NULL,
	`model` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`status_code` integer NOT NULL,
	`latency_ms` integer
);
--> statement-breakpoint
CREATE INDEX `request_logs_token_ts_idx` ON `request_logs` (`auth_token_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `request_logs_ts_idx` ON `request_logs` (`timestamp`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_token_id` integer,
	`is_super_admin` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `usage_resets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`auth_token_id` integer NOT NULL,
	`kind` text NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_resets_token_kind_idx` ON `usage_resets` (`auth_token_id`,`kind`,`reset_at`);