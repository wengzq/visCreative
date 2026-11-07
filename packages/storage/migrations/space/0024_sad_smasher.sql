CREATE TABLE `asset_tags` (
	`asset_id` text NOT NULL,
	`tag` text NOT NULL,
	`normalized` text NOT NULL,
	PRIMARY KEY(`asset_id`, `tag`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_tags_normalized` ON `asset_tags` (`asset_id`,`normalized`);--> statement-breakpoint
CREATE INDEX `asset_tags_lookup` ON `asset_tags` (`normalized`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`refs` text DEFAULT '[]' NOT NULL,
	`pending_source_node_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`series_entity_id` text,
	`series_revision` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entities_live_kind_name` ON `entities` (`kind`,lower(trim("name"))) WHERE "entities"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `entity_assets` (
	`entity_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`role` text NOT NULL,
	`added_by_proposal_id` text,
	PRIMARY KEY(`entity_id`, `asset_id`),
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`added_by_proposal_id`) REFERENCES `entity_proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entity_assets_asset` ON `entity_assets` (`asset_id`);--> statement-breakpoint
CREATE TABLE `entity_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text,
	`payload` text NOT NULL,
	`target_revision` integer,
	`resolved_entity_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entity_proposals_status` ON `entity_proposals` (`status`);--> statement-breakpoint
CREATE TABLE `library_run_changes` (
	`run_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	PRIMARY KEY(`run_id`, `asset_id`),
	FOREIGN KEY (`run_id`) REFERENCES `library_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `library_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`session_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`reverted_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `library_runs_started` ON `library_runs` (`started_at`,`id`);--> statement-breakpoint
CREATE TABLE `library_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`session_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "library_state_singleton" CHECK("library_state"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `category` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `assets` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `assets` ADD `labeled_by` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `user_fields` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `job_inputs` ADD `asset_version_id` text REFERENCES asset_versions(id);