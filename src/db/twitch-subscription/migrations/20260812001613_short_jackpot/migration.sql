CREATE TABLE `processed_eventsub_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `broadcaster` ADD `event_sub_audited_at` integer;--> statement-breakpoint
CREATE INDEX `processed_eventsub_messages_processed_at_idx` ON `processed_eventsub_messages` (`processed_at`);