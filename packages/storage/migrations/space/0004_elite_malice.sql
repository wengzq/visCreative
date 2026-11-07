ALTER TABLE `messages` ADD `skills` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `work_dir` text DEFAULT '' NOT NULL;