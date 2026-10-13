CREATE TABLE `file_chunks` (
	`site` text NOT NULL,
	`owner` text NOT NULL,
	`job_id` text NOT NULL,
	`file_id` text NOT NULL,
	`seq` integer NOT NULL,
	`payload` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`site`, `owner`, `job_id`, `file_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `file_jobs` (
	`site` text NOT NULL,
	`owner` text NOT NULL,
	`job_id` text NOT NULL,
	`payload` text NOT NULL,
	`expires` integer NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site`, `owner`, `job_id`)
);
