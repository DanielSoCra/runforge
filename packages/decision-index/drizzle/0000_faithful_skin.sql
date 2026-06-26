CREATE SCHEMA IF NOT EXISTS "decision_index";
--> statement-breakpoint
CREATE TABLE "decision_index"."applied_transitions" (
	"decision_id" text NOT NULL,
	"transition_key" text NOT NULL,
	"applied_at" text NOT NULL,
	CONSTRAINT "applied_transitions_decision_id_transition_key_pk" PRIMARY KEY("decision_id","transition_key")
);
--> statement-breakpoint
CREATE TABLE "decision_index"."audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "decision_index"."audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"decision_id" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"event" text NOT NULL,
	"transition_key" text,
	"actor" text,
	"at" text NOT NULL,
	"detail_json" text,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "decision_index"."decision_responses" (
	"decision_id" text PRIMARY KEY NOT NULL,
	"response_idempotency_key" text NOT NULL,
	"response_hash" text NOT NULL,
	"chosen_option" text,
	"answer_ref" text,
	"response_payload_json" text,
	"answerer" text NOT NULL,
	"answered_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_index"."decisions" (
	"decision_id" text PRIMARY KEY NOT NULL,
	"protocol_version" text NOT NULL,
	"status" text NOT NULL,
	"source_url" text NOT NULL,
	"source_etag" text,
	"source_event_id" text,
	"deployment" text NOT NULL,
	"run_id" text NOT NULL,
	"worker_session_id" text,
	"phase" text,
	"risk_class" text NOT NULL,
	"question" text NOT NULL,
	"context" text,
	"options_json" text NOT NULL,
	"recommended_option" text,
	"consequence_of_no_answer" text,
	"reversibility" text,
	"answer_schema_json" text NOT NULL,
	"resume_mode" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"trace_id" text,
	"agent_version" text,
	"skill_version" text,
	"expires_at" text,
	"last_seen_at" text,
	"last_notified_at" text,
	"stale" boolean DEFAULT false NOT NULL,
	"superseded_by" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"deferred_until" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_index"."outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"kind" text NOT NULL,
	"intended_transition" text NOT NULL,
	"semantic_key" text,
	"payload_ref" text,
	"state" text NOT NULL,
	"claimed_at" text,
	"claimed_by" text,
	"superseded" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" text NOT NULL,
	"committed_at" text
);
--> statement-breakpoint
CREATE TABLE "decision_index"."protected_refs" (
	"ulid" text PRIMARY KEY NOT NULL,
	"decision_id" text,
	"field" text NOT NULL,
	"class" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_index"."quarantine_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "decision_index"."quarantine_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_url" text,
	"source_event_id" text,
	"reason" text NOT NULL,
	"missing_paths" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_index"."worker_sessions" (
	"decision_id" text PRIMARY KEY NOT NULL,
	"worker_session_id" text,
	"transcript_path" text,
	"process_handle" text,
	"stop_reason" text,
	"wake_command" text,
	"work_request_ref" text,
	"requeue_command" text,
	"last_heartbeat" text,
	"abandon_reason" text,
	"resume_kind" text
);
--> statement-breakpoint
ALTER TABLE "decision_index"."applied_transitions" ADD CONSTRAINT "applied_transitions_decision_id_decisions_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "decision_index"."decisions"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_index"."audit_log" ADD CONSTRAINT "audit_log_decision_id_decisions_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "decision_index"."decisions"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_index"."decision_responses" ADD CONSTRAINT "decision_responses_decision_id_decisions_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "decision_index"."decisions"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_index"."outbox" ADD CONSTRAINT "outbox_decision_id_decisions_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "decision_index"."decisions"("decision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_index"."worker_sessions" ADD CONSTRAINT "worker_sessions_decision_id_decisions_decision_id_fk" FOREIGN KEY ("decision_id") REFERENCES "decision_index"."decisions"("decision_id") ON DELETE no action ON UPDATE no action;