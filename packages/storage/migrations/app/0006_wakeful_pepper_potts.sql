CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_live_name` ON `series` (lower(trim("name"))) WHERE "series"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE `spaces` ADD `series_id` text REFERENCES series(id);--> statement-breakpoint
ALTER TABLE `spaces` ADD `episode` integer;--> statement-breakpoint
ALTER TABLE `spaces` ADD `series_detach_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_live_series_episode` ON `spaces` (`series_id`,`episode`) WHERE "spaces"."deleted_at" IS NULL AND "spaces"."series_id" IS NOT NULL;