CREATE TABLE `contract_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`event_seq` integer NOT NULL,
	`idempotency_rowid` integer NOT NULL
);
