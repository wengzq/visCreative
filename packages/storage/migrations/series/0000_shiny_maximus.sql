CREATE TABLE `series_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_entities_live_kind_name` ON `series_entities` (`kind`,lower(trim("name"))) WHERE "series_entities"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `series_entity_revisions` (
	`series_entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`refs` text NOT NULL,
	`voice` text,
	`published_at` integer NOT NULL,
	`published_from_space_id` text,
	PRIMARY KEY(`series_entity_id`, `revision`),
	FOREIGN KEY (`series_entity_id`) REFERENCES `series_entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `series_publish_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`series_entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	FOREIGN KEY (`series_entity_id`) REFERENCES `series_entities`(`id`) ON UPDATE no action ON DELETE no action
);
