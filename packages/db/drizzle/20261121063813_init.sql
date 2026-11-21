CREATE TABLE `attention` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`options` text NOT NULL,
	`status` text NOT NULL,
	`answer` text,
	`answered_via` text,
	`created_at` text NOT NULL,
	`answered_at` text
);
--> statement-breakpoint
CREATE INDEX `attention_status_idx` ON `attention` (`status`);--> statement-breakpoint
CREATE INDEX `attention_task_idx` ON `attention` (`task_id`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`base_branch` text NOT NULL,
	`checks` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_name_unique` ON `project` (`name`);--> statement-breakpoint
CREATE TABLE `run` (
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
	`ended_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_dispatch_id_unique` ON `run` (`dispatch_id`);--> statement-breakpoint
CREATE INDEX `run_task_idx` ON `run` (`task_id`);--> statement-breakpoint
CREATE INDEX `run_state_idx` ON `run` (`state`);--> statement-breakpoint
CREATE TABLE `task` (
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_status_idx` ON `task` (`status`);--> statement-breakpoint
CREATE INDEX `task_project_idx` ON `task` (`project_id`);--> statement-breakpoint
CREATE INDEX `task_parent_idx` ON `task` (`parent_id`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text
);
--> statement-breakpoint
CREATE INDEX `workspace_task_idx` ON `workspace` (`task_id`);--> statement-breakpoint
CREATE INDEX `workspace_state_idx` ON `workspace` (`state`);--> statement-breakpoint
CREATE TABLE `counter` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `effect` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`payload` text,
	`seq` integer NOT NULL,
	`generation` integer NOT NULL,
	`attempts` integer NOT NULL,
	`due` text NOT NULL,
	`error` text,
	PRIMARY KEY(`kind`, `key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `effect_seq_unique` ON `effect` (`seq`);--> statement-breakpoint
CREATE INDEX `effect_due_idx` ON `effect` (`due`);--> statement-breakpoint
CREATE TABLE `event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`type` text NOT NULL,
	`task_id` text,
	`run_id` text,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_task_idx` ON `event` (`task_id`);--> statement-breakpoint
CREATE TABLE `idempotency` (
	`caller` text NOT NULL,
	`request_id` text NOT NULL,
	`method` text NOT NULL,
	`payload_hash` text NOT NULL,
	`state` text NOT NULL,
	`response` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`caller`, `request_id`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_state_idx` ON `idempotency` (`state`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`direction` text NOT NULL,
	`source` text NOT NULL,
	`body` text NOT NULL,
	`client_msg_id` text NOT NULL,
	`ref` text,
	`status` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_seq_unique` ON `message` (`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_channel_client_msg_id_unique` ON `message` (`channel`,`client_msg_id`);--> statement-breakpoint
CREATE TABLE `outbox` (
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
	`sent_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_signature_unique` ON `outbox` (`signature`);--> statement-breakpoint
CREATE INDEX `outbox_status_idx` ON `outbox` (`status`);--> statement-breakpoint
CREATE INDEX `outbox_task_idx` ON `outbox` (`task_id`);