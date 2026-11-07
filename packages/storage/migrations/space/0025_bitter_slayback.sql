PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_job_inputs` (
	`job_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`slot_id` text,
	`slot_revision` integer,
	`asset_version_id` text,
	`from_snapshot` integer NOT NULL,
	PRIMARY KEY(`job_id`, `ordinal`),
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_version_id`) REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`,`slot_revision`) REFERENCES `slot_revisions`(`slot_id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_inputs_one_source" CHECK(("__new_job_inputs"."asset_version_id" IS NOT NULL AND "__new_job_inputs"."slot_id" IS NULL AND "__new_job_inputs"."slot_revision" IS NULL) OR ("__new_job_inputs"."asset_version_id" IS NULL AND "__new_job_inputs"."slot_id" IS NOT NULL AND "__new_job_inputs"."slot_revision" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_job_inputs`("job_id", "ordinal", "slot_id", "slot_revision", "asset_version_id", "from_snapshot") SELECT "job_id", "ordinal", "slot_id", "slot_revision", "asset_version_id", "from_snapshot" FROM `job_inputs`;--> statement-breakpoint
DROP TABLE `job_inputs`;--> statement-breakpoint
ALTER TABLE `__new_job_inputs` RENAME TO `job_inputs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;