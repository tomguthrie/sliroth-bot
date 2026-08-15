CREATE TABLE `analytics_authorization` (
	`singleton` integer PRIMARY KEY,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`scopes_json` text NOT NULL,
	`authorized_at` integer NOT NULL,
	`validated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "analytics_authorization_singleton_check" CHECK("singleton" = 1),
	CONSTRAINT "analytics_authorization_scopes_json_check" CHECK(json_valid("scopes_json"))
);
--> statement-breakpoint
CREATE TABLE `analytics_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_pending_finalizers` (
	`stream_id` text PRIMARY KEY NOT NULL,
	`finalize_after` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `analytics_runtime` (
	`singleton` integer PRIMARY KEY,
	`status` text NOT NULL,
	`enabled_at` integer NOT NULL,
	`active_stream_id` text,
	`next_viewer_sample_at` integer,
	`next_audience_sample_at` integer,
	`next_token_validation_at` integer,
	`next_event_sub_audit_at` integer,
	CONSTRAINT "analytics_runtime_singleton_check" CHECK("singleton" = 1),
	CONSTRAINT "analytics_runtime_status_check" CHECK("status" in ('inactive', 'active', 'reauthorization_required'))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_eventsub_subscriptions` (
	`subscription_key` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`version` text NOT NULL,
	`condition_json` text NOT NULL,
	`subscription_id` text NOT NULL,
	CONSTRAINT "eventsub_subscriptions_condition_json_check" CHECK(json_valid("condition_json"))
);
--> statement-breakpoint
INSERT INTO `__new_eventsub_subscriptions`(`subscription_key`, `type`, `version`, `condition_json`, `subscription_id`)
SELECT
	`type`,
	`type`,
	CASE WHEN `type` = 'channel.update' THEN '2' ELSE '1' END,
	json_object('broadcaster_user_id', (SELECT `id` FROM `broadcaster` LIMIT 1)),
	`subscription_id`
FROM `eventsub_subscriptions`;--> statement-breakpoint
DROP TABLE `eventsub_subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_eventsub_subscriptions` RENAME TO `eventsub_subscriptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `eventsub_subscriptions_type_idx` ON `eventsub_subscriptions` (`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `eventsub_subscriptions_subscription_id_idx` ON `eventsub_subscriptions` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `analytics_oauth_states_expires_at_idx` ON `analytics_oauth_states` (`expires_at`);--> statement-breakpoint
CREATE INDEX `analytics_pending_finalizers_due_idx` ON `analytics_pending_finalizers` (`finalize_after`);
