PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_message_refs` (
	`message_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`node_id` text,
	`asset_version_id` text,
	`slot_id` text,
	`version_policy` text,
	`pinned_revision` integer,
	PRIMARY KEY(`message_id`, `ordinal`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_message_refs`("message_id", "ordinal", "node_id", "asset_version_id", "slot_id", "version_policy", "pinned_revision") SELECT "message_id", "ordinal", "node_id", "asset_version_id", "slot_id", "version_policy", "pinned_revision" FROM `message_refs`;--> statement-breakpoint
DROP TABLE `message_refs`;--> statement-breakpoint
ALTER TABLE `__new_message_refs` RENAME TO `message_refs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;