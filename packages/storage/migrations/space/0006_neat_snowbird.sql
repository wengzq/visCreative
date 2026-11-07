ALTER TABLE `generation_jobs` ADD `provider_cancelled` integer;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `quota_date` text;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `queue_reason` text;--> statement-breakpoint
UPDATE `generation_jobs` SET `quota_date` = strftime('%Y-%m-%d', `created_at` / 1000, 'unixepoch', 'localtime') WHERE `provider` NOT IN ('mock', 'render');
