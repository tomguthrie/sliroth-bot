PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_eventsub_subscriptions` (
	`type` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`subscription_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_eventsub_subscriptions`(`type`, `version`, `subscription_id`) SELECT `type`, `version`, `subscription_id` FROM `eventsub_subscriptions`;--> statement-breakpoint
DROP TABLE `eventsub_subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_eventsub_subscriptions` RENAME TO `eventsub_subscriptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `eventsub_subscriptions_type_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `eventsub_subscriptions_subscription_id_idx` ON `eventsub_subscriptions` (`subscription_id`);