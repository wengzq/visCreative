CREATE TABLE `work_slots` (
	`work_item_id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`acquired_at` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_slots_space` ON `work_slots` (`space_id`);