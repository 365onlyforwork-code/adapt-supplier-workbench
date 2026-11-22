CREATE TABLE `auth_accounts` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text REFERENCES `users`(`id`),
  `legacy_user_id` text REFERENCES `users`(`id`),
  `username` text NOT NULL,
  `username_key` text NOT NULL,
  `name` text NOT NULL,
  `email` text NOT NULL,
  `email_key` text NOT NULL,
  `password_hash` text NOT NULL,
  `password_salt` text NOT NULL,
  `password_algorithm` text NOT NULL,
  `password_iterations` integer NOT NULL CHECK (`password_iterations` > 0),
  `password_version` integer NOT NULL DEFAULT 1 CHECK (`password_version` > 0),
  `status` text NOT NULL CHECK (`status` IN ('pending','approved','rejected')),
  `role` text NOT NULL CHECK (`role` IN ('admin','user')),
  `is_bootstrap` integer NOT NULL DEFAULT 0 CHECK (`is_bootstrap` IN (0,1)),
  `must_change_password` integer NOT NULL DEFAULT 0 CHECK (`must_change_password` IN (0,1)),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `reviewed_at` text,
  `reviewed_by` text REFERENCES `users`(`id`),
  `last_operation_id` text NOT NULL,
  CHECK ((`status`='approved' AND `user_id` IS NOT NULL) OR (`status`<>'approved' AND `user_id` IS NULL)),
  CHECK (`legacy_user_id` IS NULL OR (`is_bootstrap`=0 AND (`status`<>'approved' OR `user_id`=`legacy_user_id`))),
  CHECK ((`is_bootstrap`=1 AND `role`='admin' AND `username_key`='admin' AND `status`='approved') OR (`is_bootstrap`=0 AND `role`='user' AND `username_key`<>'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_username_unique` ON `auth_accounts` (`username_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_email_unique` ON `auth_accounts` (`email_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_user_unique` ON `auth_accounts` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_legacy_user_unique` ON `auth_accounts` (`legacy_user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_bootstrap_unique` ON `auth_accounts` (`is_bootstrap`) WHERE `is_bootstrap`=1;
--> statement-breakpoint
CREATE INDEX `auth_accounts_status_created_idx` ON `auth_accounts` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `token_hash` text NOT NULL,
  `account_id` text NOT NULL REFERENCES `auth_accounts`(`id`) ON DELETE CASCADE,
  `password_version` integer NOT NULL CHECK (`password_version` > 0),
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL CHECK (`expires_at` > `created_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_unique` ON `auth_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `auth_sessions_account_idx` ON `auth_sessions` (`account_id`,`id`);
--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry_idx` ON `auth_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
  `bucket_key` text PRIMARY KEY NOT NULL,
  `attempts` integer NOT NULL CHECK (`attempts` > 0),
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_rate_limits_expiry_idx` ON `auth_rate_limits` (`expires_at`);
