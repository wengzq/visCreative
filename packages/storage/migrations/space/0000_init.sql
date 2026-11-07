CREATE TABLE `agent_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`pid` integer,
	`token_hash` text NOT NULL,
	`started_at` integer NOT NULL,
	`exited_at` integer,
	`exit_reason` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instances_token_hash_unique` ON `agent_instances` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instances_one_active` ON `agent_instances` (`session_id`) WHERE "agent_instances"."status" IN ('starting', 'ready');--> statement-breakpoint
CREATE TABLE `asset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`version` integer NOT NULL,
	`blob_hash` text NOT NULL,
	`mime` text NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`source_job_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blob_hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_versions_asset_id_version_unique` ON `asset_versions` (`asset_id`,`version`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`display_name` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`byte_size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delivery_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`output_index` integer NOT NULL,
	`target_kind` text NOT NULL,
	`node_id` text,
	`slot_id` text,
	`expected_content_revision` integer,
	`placement` text,
	`status` text NOT NULL,
	`delivered_operation_id` text,
	`created_node_id` text,
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivered_operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "delivery_bindings_slot_target" CHECK("delivery_bindings"."target_kind" <> 'slot' OR ("delivery_bindings"."node_id" IS NOT NULL AND "delivery_bindings"."slot_id" IS NOT NULL AND "delivery_bindings"."expected_content_revision" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_bindings_job_id_output_index_unique` ON `delivery_bindings` (`job_id`,`output_index`);--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload` text NOT NULL,
	`operation_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `generation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`external_task_id` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`error` text,
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generation_attempts_job_id_attempt_no_unique` ON `generation_attempts` (`job_id`,`attempt_no`);--> statement-breakpoint
CREATE TABLE `generation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`turn_id` text,
	`input_snapshot_id` text,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`params` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`cancel_requested_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`input_snapshot_id`) REFERENCES `input_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `generation_outputs` (
	`job_id` text NOT NULL,
	`output_index` integer NOT NULL,
	`asset_version_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `output_index`),
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_version_id`) REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`request_id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `input_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_inputs` (
	`job_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`slot_id` text NOT NULL,
	`slot_revision` integer NOT NULL,
	`from_snapshot` integer NOT NULL,
	PRIMARY KEY(`job_id`, `ordinal`),
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`,`slot_revision`) REFERENCES `slot_revisions`(`slot_id`,`revision`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `message_refs` (
	`message_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`node_id` text NOT NULL,
	`slot_id` text,
	`version_policy` text NOT NULL,
	`pinned_revision` integer,
	PRIMARY KEY(`message_id`, `ordinal`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`text` text NOT NULL,
	`delivery_state` text NOT NULL,
	`queue_order` real,
	`created_at` integer NOT NULL,
	`submitted_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_session_state` ON `messages` (`session_id`,`delivery_state`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`w` real NOT NULL,
	`h` real NOT NULL,
	`z` real NOT NULL,
	`layout_revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_session_id` text,
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_kind` text NOT NULL,
	`title` text NOT NULL,
	`agent_resume_id` text,
	`provider_leaf_uuid` text,
	`queue_paused` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `slot_revisions` (
	`slot_id` text NOT NULL,
	`revision` integer NOT NULL,
	`asset_version_id` text,
	`text_body` text,
	`operation_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`slot_id`, `revision`),
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_version_id`) REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "slot_revisions_single_content" CHECK("slot_revisions"."asset_version_id" IS NULL OR "slot_revisions"."text_body" IS NULL)
);
--> statement-breakpoint
CREATE TABLE `slots` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`slot_key` text NOT NULL,
	`content_type` text NOT NULL,
	`current_revision` integer DEFAULT 0 NOT NULL,
	`accepted_binding_id` text,
	`deleted_at` integer,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slots_node_id_slot_key_unique` ON `slots` (`node_id`,`slot_key`);--> statement-breakpoint
CREATE TABLE `snapshot_items` (
	`snapshot_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`node_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`slot_revision` integer NOT NULL,
	PRIMARY KEY(`snapshot_id`, `ordinal`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `input_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`,`slot_revision`) REFERENCES `slot_revisions`(`slot_id`,`revision`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transcript_entries` (
	`session_id` text NOT NULL,
	`item_id` text NOT NULL,
	`created_seq` integer NOT NULL,
	`revision` integer NOT NULL,
	`turn_id` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `item_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_entries_session_id_created_seq_unique` ON `transcript_entries` (`session_id`,`created_seq`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`instance_id` text,
	`input_snapshot_id` text,
	`status` text NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `agent_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`input_snapshot_id`) REFERENCES `input_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_message_id_unique` ON `turns` (`message_id`);