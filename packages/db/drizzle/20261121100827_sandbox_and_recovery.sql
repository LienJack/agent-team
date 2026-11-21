ALTER TABLE `project` ADD `allow_network` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `run` ADD `pid_started_at` text;--> statement-breakpoint
ALTER TABLE `run` ADD `launched_at` text;--> statement-breakpoint
ALTER TABLE `task` ADD `leader_retries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace` ADD `accepted_base_sha` text;