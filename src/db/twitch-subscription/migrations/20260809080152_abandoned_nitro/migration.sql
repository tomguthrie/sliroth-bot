CREATE TABLE `stream_messages` (
	`stream_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`enqueued_revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `stream_messages_pk` PRIMARY KEY(`stream_id`, `channel_id`)
);
--> statement-breakpoint
CREATE TABLE `streams` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`game_name` text NOT NULL,
	`viewer_count` integer NOT NULL,
	`game_box_art_url` text,
	`preview_image_url` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`vod_url` text,
	`revision` integer DEFAULT 1 NOT NULL
);
