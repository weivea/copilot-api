ALTER TABLE `auth_tokens` ADD `monthly_token_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_tokens` ADD `monthly_window_start` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `cached_tokens` integer;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `cache_creation_tokens` integer;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `reasoning_tokens` integer;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `billable_tokens` integer;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `usage_complete` integer;--> statement-breakpoint
UPDATE `request_logs`
SET `billable_tokens` = CASE
  WHEN `endpoint` = '/v1/messages/count_tokens' THEN 0
  ELSE coalesce(`total_tokens`, 0)
END
WHERE `billable_tokens` IS NULL;