PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`status` text NOT NULL,
	`operation` text NOT NULL,
	`node_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`source_layout_revision` integer NOT NULL,
	`source_asset_version_id` text,
	`session_id` text,
	`params` text NOT NULL,
	`asset_version_ids` text,
	`node_ids` text,
	`operation_id` text,
	`progress` real,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_media_tasks`("id", "request_id", "status", "operation", "node_id", "slot_id", "expected_revision", "source_layout_revision", "source_asset_version_id", "session_id", "params", "asset_version_ids", "node_ids", "operation_id", "progress", "error", "created_at", "updated_at") SELECT "id", "request_id", "status", "operation", "node_id", "slot_id", "expected_revision", "source_layout_revision", "source_asset_version_id", "session_id", "params", "asset_version_ids", "node_ids", "operation_id", "progress", "error", "created_at", "updated_at" FROM `media_tasks`;--> statement-breakpoint
DROP TABLE `media_tasks`;--> statement-breakpoint
ALTER TABLE `__new_media_tasks` RENAME TO `media_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `media_tasks_request_id_unique` ON `media_tasks` (`request_id`);--> statement-breakpoint
CREATE INDEX `media_tasks_status_created` ON `media_tasks` (`status`,`created_at`);