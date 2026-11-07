PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`review_by` text DEFAULT 'user' NOT NULL,
	`work_dir` text NOT NULL,
	`created_by` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`activation_seq` integer,
	`waiting_slot_since` integer,
	`pending_feedback` integer DEFAULT false NOT NULL,
	`review_report_id` text,
	`agent_kind` text,
	`status_changed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`review_report_id`) REFERENCES `work_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_work_items`("id", "parent_id", "title", "brief", "status", "pinned", "review_by", "work_dir", "created_by", "revision", "activation_seq", "waiting_slot_since", "pending_feedback", "review_report_id", "agent_kind", "status_changed_at", "created_at", "archived_at") SELECT "id", "parent_id", "title", "brief", "status", "pinned", "review_by", "work_dir", "created_by", "revision", "activation_seq", "waiting_slot_since", "pending_feedback", "review_report_id", "agent_kind", "status_changed_at", "created_at", "archived_at" FROM `work_items`;--> statement-breakpoint
DROP TABLE `work_items`;--> statement-breakpoint
ALTER TABLE `__new_work_items` RENAME TO `work_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `work_items_parent` ON `work_items` (`parent_id`);--> statement-breakpoint
CREATE INDEX `work_items_waiting_slot` ON `work_items` (`waiting_slot_since`);--> statement-breakpoint
DROP INDEX `sessions_one_coordinator`;--> statement-breakpoint
DROP INDEX `sessions_one_active_worker`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `role`;