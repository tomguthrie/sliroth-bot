DROP INDEX IF EXISTS `analytics_oauth_states_expires_at_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `analytics_pending_finalizers_due_idx`;--> statement-breakpoint
DROP TABLE `analytics_authorization`;--> statement-breakpoint
DROP TABLE `analytics_oauth_states`;--> statement-breakpoint
DROP TABLE `analytics_pending_finalizers`;--> statement-breakpoint
DROP TABLE `analytics_runtime`;