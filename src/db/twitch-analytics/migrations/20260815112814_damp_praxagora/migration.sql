CREATE TABLE `activity_events` (
	`event_sub_message_id` text PRIMARY KEY NOT NULL,
	`provider_event_id` text,
	`channel_id` text NOT NULL,
	`stream_id` text,
	`kind` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`actor_user_id` text,
	`actor_login` text,
	`actor_name` text,
	`target_user_id` text,
	`target_login` text,
	`target_name` text,
	`quantity` integer,
	`value` integer,
	`unit` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT `fk_activity_events_channel_id_analytics_channels_channel_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `analytics_channels`(`channel_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_activity_events_stream_id_streams_stream_id_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`stream_id`) ON DELETE RESTRICT,
	CONSTRAINT "activity_events_quantity_check" CHECK("quantity" is null or "quantity" >= 0),
	CONSTRAINT "activity_events_schema_version_check" CHECK("schema_version" > 0),
	CONSTRAINT "activity_events_details_json_check" CHECK(json_valid("details_json"))
);
--> statement-breakpoint
CREATE TABLE `analytics_capabilities` (
	`channel_id` text NOT NULL,
	`capability` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`checked_at` integer NOT NULL,
	CONSTRAINT `analytics_capabilities_pk` PRIMARY KEY(`channel_id`, `capability`),
	CONSTRAINT `fk_analytics_capabilities_channel_id_analytics_channels_channel_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `analytics_channels`(`channel_id`) ON DELETE RESTRICT,
	CONSTRAINT "analytics_capabilities_status_check" CHECK("status" in ('active', 'unavailable', 'revoked', 'error'))
);
--> statement-breakpoint
CREATE TABLE `analytics_channels` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`display_name` text NOT NULL,
	`timezone` text DEFAULT 'Europe/London' NOT NULL,
	`tracking_started_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audience_samples` (
	`sample_id` integer PRIMARY KEY AUTOINCREMENT,
	`channel_id` text NOT NULL,
	`stream_id` text,
	`sampled_at` integer NOT NULL,
	`viewer_count` integer,
	`follower_count` integer,
	`subscriber_count` integer,
	`source` text NOT NULL,
	CONSTRAINT `fk_audience_samples_channel_id_analytics_channels_channel_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `analytics_channels`(`channel_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_audience_samples_stream_id_streams_stream_id_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`stream_id`) ON DELETE RESTRICT,
	CONSTRAINT "audience_samples_source_check" CHECK("source" in ('activation', 'stream_start', 'alarm', 'stream_end')),
	CONSTRAINT "audience_samples_has_value_check" CHECK("viewer_count" is not null or "follower_count" is not null or "subscriber_count" is not null),
	CONSTRAINT "audience_samples_viewer_count_check" CHECK("viewer_count" is null or "viewer_count" >= 0),
	CONSTRAINT "audience_samples_follower_count_check" CHECK("follower_count" is null or "follower_count" >= 0),
	CONSTRAINT "audience_samples_subscriber_count_check" CHECK("subscriber_count" is null or "subscriber_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`event_sub_message_id` text PRIMARY KEY NOT NULL,
	`twitch_message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`stream_id` text,
	`sent_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`chatter_user_id` text NOT NULL,
	`chatter_login` text NOT NULL,
	`chatter_name` text NOT NULL,
	`message_type` text NOT NULL,
	`source_broadcaster_user_id` text,
	CONSTRAINT `fk_chat_messages_channel_id_analytics_channels_channel_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `analytics_channels`(`channel_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_chat_messages_stream_id_streams_stream_id_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`stream_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `stream_category_rollups` (
	`stream_id` text NOT NULL,
	`category_key` text NOT NULL,
	`category_id` text,
	`category_name` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	CONSTRAINT `stream_category_rollups_pk` PRIMARY KEY(`stream_id`, `category_key`),
	CONSTRAINT `fk_stream_category_rollups_stream_id_streams_stream_id_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`stream_id`) ON DELETE RESTRICT,
	CONSTRAINT "stream_category_rollups_duration_seconds_check" CHECK("duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE `stream_metadata_changes` (
	`change_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`stream_id` text,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`title` text NOT NULL,
	`category_id` text,
	`category_name` text,
	`language` text,
	`content_labels_json` text DEFAULT '[]' NOT NULL,
	CONSTRAINT `fk_stream_metadata_changes_channel_id_analytics_channels_channel_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `analytics_channels`(`channel_id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_stream_metadata_changes_stream_id_streams_stream_id_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`stream_id`) ON DELETE RESTRICT,
	CONSTRAINT "stream_metadata_changes_content_labels_json_check" CHECK(json_valid("content_labels_json"))
);
--> statement-breakpoint
CREATE TABLE `stream_minute_rollups` (
	`stream_id` text NOT NULL,
	`minute_at` integer NOT NULL,
	`covered_seconds` integer NOT NULL,
	`viewer_seconds` integer NOT NULL,
	`peak_viewers` integer,
	`chat_messages` integer DEFAULT 0 NOT NULL,
	`unique_chatters` integer DEFAULT 0 NOT NULL,
	`bits` integer DEFAULT 0 NOT NULL,
	`channel_points` integer DEFAULT 0 NOT NULL,
	`follows` integer DEFAULT 0 NOT NULL,
	`subscriptions` integer DEFAULT 0 NOT NULL,
	`activity_events` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `stream_minute_rollups_pk` PRIMARY KEY(`stream_id`, `minute_at`),
	CONSTRAINT `fk_stream_minute_rollups_stream_id_streams_stream_id_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`stream_id`) ON DELETE RESTRICT,
	CONSTRAINT "stream_minute_rollups_covered_seconds_check" CHECK("covered_seconds" between 0 and 60),
	CONSTRAINT "stream_minute_rollups_nonnegative_check" CHECK("viewer_seconds" >= 0 and ("peak_viewers" is null or "peak_viewers" >= 0) and "chat_messages" >= 0 and "unique_chatters" >= 0 and "bits" >= 0 and "channel_points" >= 0 and "follows" >= 0 and "subscriptions" >= 0 and "activity_events" >= 0)
);
--> statement-breakpoint
CREATE TABLE `stream_segments` (
	`stream_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`title` text NOT NULL,
	`category_id` text,
	`category_name` text,
	`language` text,
	CONSTRAINT `stream_segments_pk` PRIMARY KEY(`stream_id`, `started_at`),
	CONSTRAINT `fk_stream_segments_stream_id_streams_stream_id_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`stream_id`) ON DELETE RESTRICT,
	CONSTRAINT "stream_segments_ended_at_check" CHECK("ended_at" is null or "ended_at" > "started_at")
);
--> statement-breakpoint
CREATE TABLE `stream_summaries` (
	`stream_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`algorithm` text NOT NULL,
	`computed_at` integer NOT NULL,
	`duration_seconds` integer NOT NULL,
	`viewer_seconds` integer NOT NULL,
	`viewer_covered_seconds` integer NOT NULL,
	`peak_viewers` integer,
	`follower_count_first` integer,
	`follower_count_last` integer,
	`subscriber_count_first` integer,
	`subscriber_count_last` integer,
	`chat_messages` integer DEFAULT 0 NOT NULL,
	`unique_chatters` integer DEFAULT 0 NOT NULL,
	`bits` integer DEFAULT 0 NOT NULL,
	`channel_points` integer DEFAULT 0 NOT NULL,
	`follows` integer DEFAULT 0 NOT NULL,
	`subscriptions` integer DEFAULT 0 NOT NULL,
	`raids_in` integer DEFAULT 0 NOT NULL,
	`raids_out` integer DEFAULT 0 NOT NULL,
	`display_title` text NOT NULL,
	`primary_category_id` text,
	`primary_category_name` text,
	CONSTRAINT `fk_stream_summaries_stream_id_streams_stream_id_fk` FOREIGN KEY (`stream_id`) REFERENCES `streams`(`stream_id`) ON DELETE RESTRICT,
	CONSTRAINT "stream_summaries_revision_check" CHECK("revision" > 0),
	CONSTRAINT "stream_summaries_nonnegative_check" CHECK("duration_seconds" >= 0 and "viewer_seconds" >= 0 and "viewer_covered_seconds" >= 0 and ("peak_viewers" is null or "peak_viewers" >= 0) and ("follower_count_first" is null or "follower_count_first" >= 0) and ("follower_count_last" is null or "follower_count_last" >= 0) and ("subscriber_count_first" is null or "subscriber_count_first" >= 0) and ("subscriber_count_last" is null or "subscriber_count_last" >= 0) and "chat_messages" >= 0 and "unique_chatters" >= 0 and "bits" >= 0 and "channel_points" >= 0 and "follows" >= 0 and "subscriptions" >= 0 and "raids_in" >= 0 and "raids_out" >= 0)
);
--> statement-breakpoint
CREATE TABLE `streams` (
	`stream_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`started_recorded_at` integer NOT NULL,
	`ended_at` integer,
	`ended_recorded_at` integer,
	`status` text NOT NULL,
	`dirty` integer DEFAULT true NOT NULL,
	`finalized_at` integer,
	`summary_revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_streams_channel_id_analytics_channels_channel_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `analytics_channels`(`channel_id`) ON DELETE RESTRICT,
	CONSTRAINT "streams_status_check" CHECK("status" in ('live', 'finalizing', 'finalized')),
	CONSTRAINT "streams_ended_at_check" CHECK("ended_at" is null or "ended_at" >= "started_at"),
	CONSTRAINT "streams_summary_revision_check" CHECK("summary_revision" >= 0)
);
--> statement-breakpoint
CREATE INDEX `activity_events_stream_occurred_at_idx` ON `activity_events` (`stream_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `activity_events_stream_kind_idx` ON `activity_events` (`stream_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `audience_samples_channel_sampled_at_idx` ON `audience_samples` (`channel_id`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `audience_samples_stream_sampled_at_idx` ON `audience_samples` (`stream_id`,`sampled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_twitch_message_id_idx` ON `chat_messages` (`twitch_message_id`);--> statement-breakpoint
CREATE INDEX `chat_messages_stream_sent_at_idx` ON `chat_messages` (`stream_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_stream_chatter_idx` ON `chat_messages` (`stream_id`,`chatter_user_id`);--> statement-breakpoint
CREATE INDEX `stream_metadata_changes_stream_occurred_at_idx` ON `stream_metadata_changes` (`stream_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `streams_channel_started_at_idx` ON `streams` (`channel_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `streams_channel_status_idx` ON `streams` (`channel_id`,`status`);