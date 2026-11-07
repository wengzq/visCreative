ALTER TABLE `author_skill_drafts` ADD `status` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `author_skills` ADD `add_to_new_projects` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `author_skills` ADD `deleted_at` integer;