CREATE TABLE `undo_entries` (
	`id` text NOT NULL,
	`operation_id` text NOT NULL,
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state` text NOT NULL,
	`inverse` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `undo_entries_id_unique` ON `undo_entries` (`id`);