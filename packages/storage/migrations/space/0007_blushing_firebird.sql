CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`review_by` text DEFAULT 'user' NOT NULL,
	`work_dir` text NOT NULL,
	`frame_node_id` text,
	`created_by` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`activation_seq` integer,
	`waiting_slot_since` integer,
	`pending_feedback` integer DEFAULT false NOT NULL,
	`agent_kind` text,
	`status_changed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`frame_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `work_items_parent` ON `work_items` (`parent_id`);--> statement-breakpoint
CREATE INDEX `work_items_waiting_slot` ON `work_items` (`waiting_slot_since`);--> statement-breakpoint
CREATE TABLE `work_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`body` text NOT NULL,
	`refs` text DEFAULT '{}' NOT NULL,
	`reply_to` text,
	`delivery_id` text,
	`resolved_by` text,
	`redelivered` integer DEFAULT false NOT NULL,
	`target_session_id` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`acked_at` integer,
	`read_at` integer,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to`) REFERENCES `work_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `work_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_messages_item_created` ON `work_messages` (`work_item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `work_messages_session_delivery` ON `work_messages` (`target_session_id`,`delivery_id`);--> statement-breakpoint
ALTER TABLE `nodes` ADD `frame` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `frame_id` text REFERENCES nodes(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `work_item_id` text REFERENCES work_items(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `role` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_coordinator` ON `sessions` (`work_item_id`) WHERE "sessions"."role" = 'coordinator';--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_active_worker` ON `sessions` (`work_item_id`) WHERE "sessions"."role" = 'worker' AND "sessions"."archived_at" IS NULL;--> statement-breakpoint
INSERT INTO `work_items` (`id`, `title`, `status`, `work_dir`, `created_by`, `agent_kind`, `status_changed_at`, `created_at`, `archived_at`)
SELECT 'work_' || substr(`id`, 5), `title`, CASE WHEN `archived_at` IS NULL THEN 'in_progress' ELSE 'done' END, `work_dir`, '{"kind":"user"}', `agent_kind`, coalesce(`archived_at`, `created_at`), `created_at`, `archived_at`
FROM `sessions`;--> statement-breakpoint
UPDATE `sessions` SET `work_item_id` = 'work_' || substr(`id`, 5);
