CREATE TABLE `author_skill_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`space_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `author_skill_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `author_skill_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `author_skills`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `author_skill_version_hash` ON `author_skill_versions` (`skill_id`,`content_hash`);--> statement-breakpoint
CREATE TABLE `author_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`version` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
