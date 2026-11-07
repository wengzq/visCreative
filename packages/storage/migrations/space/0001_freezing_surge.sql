CREATE TABLE `node_inputs` (
	`node_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`input_node_id` text NOT NULL,
	PRIMARY KEY(`node_id`, `ordinal`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`input_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
