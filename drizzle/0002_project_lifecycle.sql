ALTER TABLE `projects` ADD COLUMN `inactive_at` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `lifecycle_version` integer NOT NULL DEFAULT 0 CHECK (`lifecycle_version` >= 0);
--> statement-breakpoint
CREATE INDEX `projects_lifecycle_idx` ON `projects` (`deleted_at`, `inactive_at`, `updated_at`);
