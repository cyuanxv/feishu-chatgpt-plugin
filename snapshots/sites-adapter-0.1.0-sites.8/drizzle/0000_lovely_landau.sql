CREATE TABLE `connections` (
	`site` text NOT NULL,
	`user_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`tenant_key` text NOT NULL,
	`open_id` text NOT NULL,
	`display_name` text NOT NULL,
	`credentials` text,
	`scopes` text NOT NULL,
	`expires` integer NOT NULL,
	`refresh_expires` integer NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`rate_key` text PRIMARY KEY NOT NULL,
	`window` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owners` (
	`site` text NOT NULL,
	`user_id` text NOT NULL,
	`epoch` text NOT NULL,
	PRIMARY KEY(`site`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`user_id` text NOT NULL,
	`cookie_hash` text NOT NULL,
	`verifier` text NOT NULL,
	`epoch` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_expiry` ON `oauth_states` (`expires`);