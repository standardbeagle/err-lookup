CREATE TABLE `errors` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`slug` text NOT NULL,
	`error_code` text,
	`error_message` text NOT NULL,
	`message_pattern` text NOT NULL,
	`error_type` text NOT NULL,
	`error_class` text,
	`http_status` integer,
	`severity` text NOT NULL,
	`file_path` text NOT NULL,
	`line_number` integer,
	`source_code` text,
	`source_code_start` integer,
	`source_code_end` integer,
	`github_url` text NOT NULL,
	`documentation` text,
	`trigger_scenarios` text,
	`common_situations` text,
	`solutions` text,
	`example_fix` text,
	`handling_strategy` text,
	`validation_code` text,
	`type_guard` text,
	`try_catch_pattern` text,
	`prevention_tips` text,
	`tags` text,
	`analyzed_sha` text NOT NULL,
	`analyzed_at` text NOT NULL,
	`schema_version` integer DEFAULT 2 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_errors_repo_slug` ON `errors` (`repo`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_errors_repo` ON `errors` (`repo`);--> statement-breakpoint
CREATE INDEX `idx_errors_code` ON `errors` (`error_code`);--> statement-breakpoint
CREATE TABLE `job_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo` text NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`duration_ms` integer,
	`analyzed_sha` text,
	`error_log` text
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_repo` ON `job_history` (`repo`,`started_at`);--> statement-breakpoint
CREATE TABLE `queue` (
	`repo` text PRIMARY KEY NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_queue_status_priority` ON `queue` (`status`,`priority`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`repo` text PRIMARY KEY NOT NULL,
	`description` text,
	`language` text,
	`stars` integer DEFAULT 0 NOT NULL,
	`default_branch` text NOT NULL,
	`analyzed_sha` text,
	`analyzed_at` text,
	`error_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_repos_status` ON `repositories` (`status`,`updated_at`);