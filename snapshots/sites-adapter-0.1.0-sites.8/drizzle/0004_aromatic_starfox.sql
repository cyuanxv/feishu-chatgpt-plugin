CREATE TABLE `write_intents` (
	`site` text NOT NULL,
	`owner` text NOT NULL,
	`intent_id` text NOT NULL,
	`request_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`connection_id` text NOT NULL,
	`scoped_user` text NOT NULL,
	`grant_id` text NOT NULL,
	`operation` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`receipt` text,
	`expires` integer NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`site`, `owner`, `intent_id`)
);
--> statement-breakpoint
CREATE INDEX `write_request_lookup` ON `write_intents` (`site`,`owner`,`request_id`);