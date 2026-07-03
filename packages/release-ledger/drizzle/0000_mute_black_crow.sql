CREATE SCHEMA IF NOT EXISTS "release_ledger";
--> statement-breakpoint
CREATE TABLE "release_ledger"."release_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "release_ledger"."release_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"release_id" text NOT NULL,
	"deployment" text NOT NULL,
	"event" text NOT NULL,
	"target_revision" text,
	"detail_json" text,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "release_events_one_proposal_per_release" ON "release_ledger"."release_events" USING btree ("release_id") WHERE "release_ledger"."release_events"."event" = 'proposal';