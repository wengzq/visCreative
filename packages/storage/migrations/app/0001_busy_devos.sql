CREATE TABLE `idempotency_keys` (
	`request_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `spaces` ADD `root_path` text DEFAULT '' NOT NULL;