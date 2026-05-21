CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."activity_event_type" AS ENUM('state-transition', 'merge', 'error', 'heartbeat', 'completion');--> statement-breakpoint
CREATE TYPE "public"."activity_severity" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."invite_status" AS ENUM('pending', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."key_type" AS ENUM('source-control', 'model-provider', 'webhook-secret');--> statement-breakpoint
CREATE TYPE "public"."matrix_status" AS ENUM('ok', 'degraded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."notification_channel_type" AS ENUM('web-push', 'slack', 'macos', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."notification_event_kind" AS ENUM('attention-required', 'work-completed', 'error', 'digest');--> statement-breakpoint
CREATE TYPE "public"."run_outcome" AS ENUM('in-progress', 'complete', 'stuck', 'escalated', 'failed');--> statement-breakpoint
CREATE TYPE "public"."session_type" AS ENUM('planning', 'implementation', 'validation', 'diagnosis', 'fix');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('admin', 'viewer');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" "activity_event_type" NOT NULL,
	"severity" "activity_severity" DEFAULT 'info' NOT NULL,
	"summary" text NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"key_type" "key_type" NOT NULL,
	"encrypted_value" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status_line" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attention" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forecast" text NOT NULL,
	"signal_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"session_type" "session_type" NOT NULL,
	"cost" numeric(10, 6) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"github_login" text NOT NULL,
	"avatar_url" text,
	"connection_type" text DEFAULT 'oauth_token' NOT NULL,
	"encrypted_token" "bytea" NOT NULL,
	"token_expires_at" timestamp with time zone,
	"scopes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"is_selected" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concurrency_limit" integer DEFAULT 3 NOT NULL,
	"daily_budget_limit" numeric(10, 4),
	"default_model" text DEFAULT 'claude-sonnet-4-6' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "global_settings" ("concurrency_limit") VALUES (3);--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_handle" text NOT NULL,
	"role" "team_role" DEFAULT 'viewer' NOT NULL,
	"invited_by" uuid,
	"status" "invite_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channel_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_type" "notification_channel_type" NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"events" "notification_event_kind"[] DEFAULT '{}'::notification_event_kind[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_global_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "repo_plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"recommended" boolean DEFAULT false NOT NULL,
	"recommendation_reason" text,
	"recommended_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"staging_branch" text DEFAULT 'staging' NOT NULL,
	"production_branch" text DEFAULT 'main' NOT NULL,
	"budget_limit" numeric(10, 4),
	"concurrency_limit" integer DEFAULT 1 NOT NULL,
	"poll_interval_ms" integer,
	"connection_id" uuid,
	"github_status" text DEFAULT 'ok' NOT NULL,
	"matrix_status" "matrix_status" DEFAULT 'ok' NOT NULL,
	"credential_status" text DEFAULT 'ok' NOT NULL,
	"credential_error" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_credential_status_check" CHECK ("credential_status" IN ('ok', 'error'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"issue_number" integer NOT NULL,
	"issue_title" text NOT NULL,
	"pipeline_variant" text DEFAULT 'standard' NOT NULL,
	"current_phase" text,
	"outcome" "run_outcome" DEFAULT 'in-progress' NOT NULL,
	"total_cost" numeric(10, 6) DEFAULT 0 NOT NULL,
	"phases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fix_attempts" integer DEFAULT 0 NOT NULL,
	"report" text,
	"active_plugins" text[] DEFAULT '{}'::text[] NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "team_role" DEFAULT 'viewer' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_orgs" ADD CONSTRAINT "github_orgs_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_plugins" ADD CONSTRAINT "repo_plugins_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activity_events_occurred_at" ON "activity_events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_repo_id_key_type_key" ON "api_keys" USING btree ("repo_id","key_type");--> statement-breakpoint
CREATE INDEX "idx_briefings_generated_at" ON "briefings" USING btree ("generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_cost_events_run_id" ON "cost_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_cost_events_recorded_at" ON "cost_events" USING btree ("recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "github_orgs_connection_id_github_id_key" ON "github_orgs" USING btree ("connection_id","github_id");--> statement-breakpoint
CREATE INDEX "idx_github_orgs_connection_id" ON "github_orgs" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_provider_handle_status_key" ON "invitations" USING btree ("provider_handle","status");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_global_settings_plugin_id_key" ON "plugin_global_settings" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "idx_plugin_global_settings_plugin_id" ON "plugin_global_settings" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_plugins_repo_id_plugin_id_key" ON "repo_plugins" USING btree ("repo_id","plugin_id");--> statement-breakpoint
CREATE INDEX "idx_repo_plugins_repo_id" ON "repo_plugins" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "idx_repo_plugins_active" ON "repo_plugins" USING btree ("repo_id","active") WHERE "active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_owner_name_key" ON "repos" USING btree ("owner","name");--> statement-breakpoint
CREATE INDEX "idx_repos_enabled" ON "repos" USING btree ("enabled") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_repos_connection_id" ON "repos" USING btree ("connection_id") WHERE "connection_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runs_repo_id" ON "runs" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "idx_runs_started_at" ON "runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_runs_updated_at" ON "runs" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER trg_runs_updated_at
BEFORE UPDATE ON "runs"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_user_id_key" ON "team_members" USING btree ("user_id");
