CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `email_key` text NOT NULL,
  `name` text NOT NULL,
  `created_at` text NOT NULL,
  `last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_key_unique` ON `users` (`email_key`);
--> statement-breakpoint
CREATE TABLE `projects` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `data_json` text NOT NULL,
  `summary_json` text NOT NULL,
  `preferences_json` text NOT NULL,
  `source_json` text NOT NULL,
  `created_by` text NOT NULL REFERENCES `users`(`id`),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `version` integer NOT NULL DEFAULT 1 CHECK (`version` > 0),
  `creation_token` text NOT NULL,
  `last_operation_id` text NOT NULL,
  `mutation_id` text,
  `deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_creator_mutation_unique` ON `projects` (`created_by`, `mutation_id`);
--> statement-breakpoint
CREATE TABLE `project_members` (
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `role` text NOT NULL CHECK (`role` IN ('administrator','evaluator','viewer')),
  `can_export` integer NOT NULL DEFAULT 0 CHECK (`can_export` IN (0,1)),
  `joined_at` text NOT NULL,
  `last_operation_id` text NOT NULL,
  PRIMARY KEY (`project_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `project_members_user_idx` ON `project_members` (`user_id`);
--> statement-breakpoint
CREATE TABLE `project_versions` (
  `project_id` text NOT NULL REFERENCES `projects`(`id`),
  `version` integer NOT NULL,
  `data_json` text NOT NULL,
  `summary_json` text NOT NULL,
  `preferences_json` text NOT NULL,
  `changed_by` text NOT NULL REFERENCES `users`(`id`),
  `changed_at` text NOT NULL,
  `kind` text NOT NULL,
  PRIMARY KEY (`project_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `project_title` text NOT NULL,
  `actor_id` text REFERENCES `users`(`id`),
  `actor_email` text,
  `actor_name` text,
  `kind` text NOT NULL,
  `label` text NOT NULL,
  `detail` text NOT NULL,
  `occurred_at` text NOT NULL,
  `source` text NOT NULL CHECK (`source` IN ('server','legacy')),
  `version` integer,
  `metadata_json` text NOT NULL,
  `legacy_id` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_project_time_idx` ON `audit_events` (`project_id`, `occurred_at`);
--> statement-breakpoint
CREATE INDEX `audit_events_actor_time_idx` ON `audit_events` (`actor_id`, `occurred_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_legacy_unique` ON `audit_events` (`project_id`, `legacy_id`);
--> statement-breakpoint
CREATE TABLE `local_migrations` (
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `local_id` text NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`),
  `local_created_at` text,
  `local_updated_at` text,
  `migrated_at` text NOT NULL,
  `completed_at` text,
  PRIMARY KEY (`user_id`, `local_id`)
);
