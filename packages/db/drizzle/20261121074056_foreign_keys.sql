PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_workspace`("id", "task_id", "path", "branch", "base_sha", "head_sha", "state", "created_at", "removed_at") SELECT "id", "task_id", "path", "branch", "base_sha", "head_sha", "state", "created_at", "removed_at" FROM `workspace`;--> statement-breakpoint
DROP TABLE `workspace`;--> statement-breakpoint
ALTER TABLE `__new_workspace` RENAME TO `workspace`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `workspace_task_idx` ON `workspace` (`task_id`);--> statement-breakpoint
CREATE INDEX `workspace_state_idx` ON `workspace` (`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_current_task_unique` ON `workspace` (`task_id`) WHERE state <> 'removed';--> statement-breakpoint
CREATE TABLE `__new_attention` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`options` text NOT NULL,
	`status` text NOT NULL,
	`answer` text,
	`answered_via` text,
	`created_at` text NOT NULL,
	`answered_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_attention`("id", "task_id", "kind", "question", "options", "status", "answer", "answered_via", "created_at", "answered_at") SELECT "id", "task_id", "kind", "question", "options", "status", "answer", "answered_via", "created_at", "answered_at" FROM `attention`;--> statement-breakpoint
DROP TABLE `attention`;--> statement-breakpoint
ALTER TABLE `__new_attention` RENAME TO `attention`;--> statement-breakpoint
CREATE INDEX `attention_status_idx` ON `attention` (`status`);--> statement-breakpoint
CREATE INDEX `attention_task_idx` ON `attention` (`task_id`);--> statement-breakpoint
CREATE TABLE `__new_run` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`workspace_id` text NOT NULL,
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
	`log_dir` text NOT NULL,
	`pid` integer,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_run`("id", "task_id", "workspace_id", "dispatch_id", "kind", "role", "model_alias", "runner", "model", "state", "outcome", "reject_reason", "error", "session_ref", "receipt", "usage", "cost_usd", "log_dir", "pid", "started_at", "ended_at") SELECT "id", "task_id", "workspace_id", "dispatch_id", "kind", "role", "model_alias", "runner", "model", "state", "outcome", "reject_reason", "error", "session_ref", "receipt", "usage", "cost_usd", "log_dir", "pid", "started_at", "ended_at" FROM `run`;--> statement-breakpoint
DROP TABLE `run`;--> statement-breakpoint
ALTER TABLE `__new_run` RENAME TO `run`;--> statement-breakpoint
CREATE UNIQUE INDEX `run_dispatch_id_unique` ON `run` (`dispatch_id`);--> statement-breakpoint
CREATE INDEX `run_task_idx` ON `run` (`task_id`);--> statement-breakpoint
CREATE INDEX `run_state_idx` ON `run` (`state`);--> statement-breakpoint
CREATE TABLE `__new_task` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`tier` text NOT NULL,
	`ticket_md` text NOT NULL,
	`owned_paths` text NOT NULL,
	`priority` integer NOT NULL,
	`status` text NOT NULL,
	`impl_role` text NOT NULL,
	`fix_rounds` integer NOT NULL,
	`attempts` integer NOT NULL,
	`blocked_reason` text,
	`version` integer NOT NULL,
	`current_run_id` text,
	`retry_at` text,
	`fix_notes` text,
	`recovery_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_task`("id", "project_id", "parent_id", "title", "tier", "ticket_md", "owned_paths", "priority", "status", "impl_role", "fix_rounds", "attempts", "blocked_reason", "version", "current_run_id", "retry_at", "fix_notes", "recovery_note", "created_at", "updated_at") SELECT "id", "project_id", "parent_id", "title", "tier", "ticket_md", "owned_paths", "priority", "status", "impl_role", "fix_rounds", "attempts", "blocked_reason", "version", "current_run_id", "retry_at", "fix_notes", "recovery_note", "created_at", "updated_at" FROM `task`;--> statement-breakpoint
DROP TABLE `task`;--> statement-breakpoint
ALTER TABLE `__new_task` RENAME TO `task`;--> statement-breakpoint
CREATE INDEX `task_status_idx` ON `task` (`status`);--> statement-breakpoint
CREATE INDEX `task_project_idx` ON `task` (`project_id`);--> statement-breakpoint
CREATE INDEX `task_parent_idx` ON `task` (`parent_id`);--> statement-breakpoint
CREATE TABLE `__new_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`signature` text NOT NULL,
	`status` text NOT NULL,
	`task_id` text,
	`attempts` integer NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `task`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_outbox`("id", "target", "kind", "body", "signature", "status", "task_id", "attempts", "error", "created_at", "sent_at") SELECT "id", "target", "kind", "body", "signature", "status", "task_id", "attempts", "error", "created_at", "sent_at" FROM `outbox`;--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_signature_unique` ON `outbox` (`signature`);--> statement-breakpoint
CREATE INDEX `outbox_status_idx` ON `outbox` (`status`);--> statement-breakpoint
CREATE INDEX `outbox_task_idx` ON `outbox` (`task_id`);