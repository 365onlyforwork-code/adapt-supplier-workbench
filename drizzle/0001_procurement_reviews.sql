CREATE TABLE `project_reviews` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `project_version` integer NOT NULL,
  `project_title` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('pending','confirmed','returned')),
  `content_json` text NOT NULL,
  `submitted_by` text NOT NULL REFERENCES `users`(`id`),
  `submitted_name` text NOT NULL,
  `submitted_at` text NOT NULL,
  `reviewed_by` text REFERENCES `users`(`id`),
  `reviewed_name` text,
  `reviewed_at` text,
  `review_comment` text NOT NULL DEFAULT '',
  `decision_operation_id` text,
  FOREIGN KEY (`project_id`, `project_version`) REFERENCES `project_versions`(`project_id`, `version`),
  CHECK ((`status`='pending' AND `reviewed_by` IS NULL AND `reviewed_at` IS NULL) OR
         (`status`<>'pending' AND `reviewed_by` IS NOT NULL AND `reviewed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `project_reviews_history_idx` ON `project_reviews` (`project_id`, `submitted_at`, `id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_reviews_one_pending_idx` ON `project_reviews` (`project_id`) WHERE `status`='pending';
--> statement-breakpoint
CREATE UNIQUE INDEX `project_reviews_confirmed_version_idx` ON `project_reviews` (`project_id`, `project_version`) WHERE `status`='confirmed';
