CREATE TABLE `downloaded_attachments` (
	`site` text NOT NULL,
	`owner` text NOT NULL,
	`file_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`payload` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`site`, `owner`, `file_id`)
);
