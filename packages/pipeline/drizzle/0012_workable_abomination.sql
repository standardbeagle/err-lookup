CREATE TABLE `tag_decisions` (
	`proposal` text PRIMARY KEY NOT NULL,
	`canonical` text,
	`method` text NOT NULL,
	`confidence` real,
	`runner_up` text,
	`model` text,
	`decided_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tag_decisions_canonical` ON `tag_decisions` (`canonical`);--> statement-breakpoint
ALTER TABLE `errors` ADD `background_tag_raw` text;--> statement-breakpoint
-- Every existing background_tag IS the model's raw proposal: until this
-- migration the column held whatever the enrichment coined, folded only for
-- spelling. Seeding the new column from it is what lets the classifier find
-- the corpus's proposals at all, and what keeps a record traceable to its
-- proposal once background_tag is rewritten to a canonical family.
UPDATE `errors` SET `background_tag_raw` = `background_tag` WHERE `background_tag_raw` IS NULL AND `background_tag` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_errors_background_tag_raw` ON `errors` (`background_tag_raw`);
