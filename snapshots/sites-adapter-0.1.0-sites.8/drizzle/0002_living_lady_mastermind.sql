CREATE TABLE `oauth_form_submissions` (
	`site` text NOT NULL,
	`user_id` text NOT NULL,
	`csrf_hash` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`site`, `user_id`, `csrf_hash`)
);
