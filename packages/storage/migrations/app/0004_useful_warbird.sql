PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_generation_quota` (
	`job_id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_generation_quota`("job_id", "space_id", "kind", "date", "state", "created_at") SELECT "job_id", "space_id", "kind", "date", "state", "created_at" FROM `generation_quota`;--> statement-breakpoint
DROP TABLE `generation_quota`;--> statement-breakpoint
ALTER TABLE `__new_generation_quota` RENAME TO `generation_quota`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `generation_quota_date_kind` ON `generation_quota` (`date`,`kind`);--> statement-breakpoint
ALTER TABLE `spaces` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `spaces` ADD `purge_error` text;