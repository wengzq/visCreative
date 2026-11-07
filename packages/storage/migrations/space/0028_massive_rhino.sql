CREATE TABLE `text_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_id` text NOT NULL,
	`session_id` text NOT NULL,
	`base_revision` integer NOT NULL,
	`summary` text NOT NULL,
	`edits` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `text_proposals_slot_status` ON `text_proposals` (`slot_id`,`status`);