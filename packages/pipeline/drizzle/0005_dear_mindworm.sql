ALTER TABLE `errors` ADD `background_tag` text;--> statement-breakpoint
CREATE INDEX `idx_errors_background_tag` ON `errors` (`background_tag`);