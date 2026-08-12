CREATE TABLE `info_pages` (
	`slug` text PRIMARY KEY NOT NULL,
	`cluster_key` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`background` text NOT NULL,
	`common_causes` text NOT NULL,
	`fixes` text NOT NULL,
	`guide_slugs` text NOT NULL,
	`error_ids` text NOT NULL,
	`error_count` integer NOT NULL,
	`repo_count` integer NOT NULL,
	`generated_at` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_info_pages_cluster` ON `info_pages` (`cluster_key`);