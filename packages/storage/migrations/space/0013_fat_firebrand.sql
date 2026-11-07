ALTER TABLE `message_refs` ADD `asset_version_id` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `category` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `purpose` text DEFAULT 'artifact' NOT NULL;--> statement-breakpoint
ALTER TABLE `nodes` ADD `format` text DEFAULT 'plain' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `approval_mode` text DEFAULT 'ask' NOT NULL;