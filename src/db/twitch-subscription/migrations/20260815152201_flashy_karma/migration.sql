ALTER TABLE `analytics_runtime` ADD `offline_suspected_at` integer;--> statement-breakpoint
ALTER TABLE `analytics_runtime` ADD `consecutive_stream_misses` integer DEFAULT 0 NOT NULL;
