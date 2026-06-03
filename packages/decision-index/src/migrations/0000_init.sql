CREATE TABLE `applied_transitions` (
	`decision_id` text NOT NULL,
	`transition_key` text NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY(`decision_id`, `transition_key`),
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`decision_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`event` text NOT NULL,
	`transition_key` text,
	`actor` text,
	`at` text NOT NULL,
	`detail_json` text,
	`trace_id` text,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`decision_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `decision_responses` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`response_idempotency_key` text NOT NULL,
	`response_hash` text NOT NULL,
	`chosen_option` text,
	`answer_ref` text,
	`answerer` text NOT NULL,
	`answered_at` text NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`decision_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`protocol_version` text NOT NULL,
	`status` text NOT NULL,
	`source_url` text NOT NULL,
	`source_etag` text,
	`source_event_id` text,
	`deployment` text NOT NULL,
	`run_id` text NOT NULL,
	`worker_session_id` text,
	`phase` text,
	`risk_class` text NOT NULL,
	`question` text NOT NULL,
	`context` text,
	`options_json` text NOT NULL,
	`recommended_option` text,
	`consequence_of_no_answer` text,
	`reversibility` text,
	`answer_schema_json` text NOT NULL,
	`resume_mode` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`trace_id` text,
	`agent_version` text,
	`skill_version` text,
	`expires_at` text,
	`last_seen_at` text,
	`last_notified_at` text,
	`stale` integer DEFAULT false NOT NULL,
	`superseded_by` text,
	`pinned` integer DEFAULT false NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`deferred_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text NOT NULL,
	`kind` text NOT NULL,
	`intended_transition` text NOT NULL,
	`payload_ref` text,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`committed_at` text,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`decision_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `protected_refs` (
	`ulid` text PRIMARY KEY NOT NULL,
	`decision_id` text,
	`field` text NOT NULL,
	`class` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quarantine_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_url` text,
	`source_event_id` text,
	`reason` text NOT NULL,
	`missing_paths` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_sessions` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`worker_session_id` text,
	`transcript_path` text,
	`process_handle` text,
	`stop_reason` text,
	`wake_command` text,
	`work_request_ref` text,
	`requeue_command` text,
	`last_heartbeat` text,
	`abandon_reason` text,
	`resume_kind` text,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`decision_id`) ON UPDATE no action ON DELETE no action
);
