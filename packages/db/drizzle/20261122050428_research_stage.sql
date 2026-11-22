PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_run` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`workspace_id` text,
	`dispatch_id` text NOT NULL,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`model_alias` text NOT NULL,
	`runner` text NOT NULL,
	`model` text NOT NULL,
	`state` text NOT NULL,
	`outcome` text,
	`reject_reason` text,
	`error` text,
	`session_ref` text,
	`receipt` text,
	`usage` text,
	`cost_usd` real,
	`cost_estimated` integer DEFAULT false NOT NULL,
	`log_dir` text NOT NULL,
	`pid` integer,
	`pid_started_at` text,
	`launched_at` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_run`("id", "task_id", "workspace_id", "dispatch_id", "kind", "role", "model_alias", "runner", "model", "state", "outcome", "reject_reason", "error", "session_ref", "receipt", "usage", "cost_usd", "cost_estimated", "log_dir", "pid", "pid_started_at", "launched_at", "started_at", "ended_at") SELECT "id", "task_id", "workspace_id", "dispatch_id", "kind", "role", "model_alias", "runner", "model", "state", "outcome", "reject_reason", "error", "session_ref", "receipt", "usage", "cost_usd", "cost_estimated", "log_dir", "pid", "pid_started_at", "launched_at", "started_at", "ended_at" FROM `run`;--> statement-breakpoint
DROP TABLE `run`;--> statement-breakpoint
ALTER TABLE `__new_run` RENAME TO `run`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `run_dispatch_id_unique` ON `run` (`dispatch_id`);--> statement-breakpoint
CREATE INDEX `run_task_idx` ON `run` (`task_id`);--> statement-breakpoint
CREATE INDEX `run_state_idx` ON `run` (`state`);--> statement-breakpoint
ALTER TABLE `task` ADD `kind` text DEFAULT 'impl' NOT NULL;--> statement-breakpoint
ALTER TABLE `task` ADD `research_refs` text DEFAULT '[]' NOT NULL;