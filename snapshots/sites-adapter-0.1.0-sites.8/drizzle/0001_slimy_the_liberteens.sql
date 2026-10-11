CREATE TABLE `synthetic_state` (
	`site` text NOT NULL,
	`user_id` text NOT NULL,
	`fixture_id` text NOT NULL,
	PRIMARY KEY(`site`, `user_id`)
);
