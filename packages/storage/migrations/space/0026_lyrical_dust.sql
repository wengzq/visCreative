ALTER TABLE `entities` ADD `series_base_revision` integer;--> statement-breakpoint
ALTER TABLE `entities` ADD `series_member_asset_ids` text DEFAULT '[]' NOT NULL;