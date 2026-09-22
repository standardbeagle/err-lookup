CREATE TABLE `page_tag_decisions` (
	`error_id` text PRIMARY KEY NOT NULL,
	`choice` text,
	`method` text NOT NULL,
	`confidence` real,
	`runner_up` text,
	`model` text,
	`taxonomy_version` text NOT NULL,
	`decided_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_page_tag_decisions_version` ON `page_tag_decisions` (`taxonomy_version`);--> statement-breakpoint
ALTER TABLE `errors` ADD `background_tag_raw` text;--> statement-breakpoint
-- Every existing background_tag IS the model's raw proposal: until this
-- migration the column held whatever the enrichment coined, folded only for
-- spelling. Seeding the new column from it keeps each record traceable to the
-- name that produced it once background_tag is rewritten to a declared family,
-- and gives the taxonomy proposal step the corpus's names to work from.
UPDATE `errors` SET `background_tag_raw` = `background_tag` WHERE `background_tag_raw` IS NULL AND `background_tag` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_errors_background_tag_raw` ON `errors` (`background_tag_raw`);