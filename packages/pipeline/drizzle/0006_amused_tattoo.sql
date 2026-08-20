CREATE TABLE `phase_batches` (
	`repo` text NOT NULL,
	`sha` text NOT NULL,
	`phase` text NOT NULL,
	`batch_key` text NOT NULL,
	`result` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`repo`, `sha`, `phase`, `batch_key`)
);
