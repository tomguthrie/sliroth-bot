CREATE TABLE `broadcaster` (
	`id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`display_name` text NOT NULL,
	`profile_image_url` text NOT NULL,
	`offline_image_url` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eventsub_subscriptions` (
	`type` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscribers` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`message` text,
	`offline` text,
	`ping` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `eventsub_subscriptions_subscription_id_idx` ON `eventsub_subscriptions` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `subscribers_guild_id_idx` ON `subscribers` (`guild_id`);