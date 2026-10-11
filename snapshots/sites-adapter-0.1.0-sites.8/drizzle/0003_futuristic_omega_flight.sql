CREATE TABLE `app_registry` (
	`site` text NOT NULL,
	`owner` text NOT NULL,
	`app_id` text NOT NULL,
	`label` text NOT NULL,
	`secret` text NOT NULL,
	`scopes` text NOT NULL,
	PRIMARY KEY(`site`, `owner`, `app_id`)
);
--> statement-breakpoint
ALTER TABLE `connections` ADD `union_id` text;