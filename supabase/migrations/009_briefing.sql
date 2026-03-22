-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE activity_event_type AS ENUM (
  'state-transition', 'merge', 'error', 'heartbeat', 'completion'
);

CREATE TYPE activity_severity AS ENUM ('info', 'warning', 'error');

CREATE TYPE notification_channel_type AS ENUM (
  'web-push', 'slack', 'macos', 'webhook'
);

CREATE TYPE notification_event_kind AS ENUM (
  'attention-required', 'work-completed', 'error', 'digest'
);

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status_line text NOT NULL,
  changes jsonb NOT NULL DEFAULT '[]',
  attention jsonb NOT NULL DEFAULT '[]',
  forecast text NOT NULL,
  signal_snapshot jsonb NOT NULL DEFAULT '{}',
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type activity_event_type NOT NULL,
  severity activity_severity NOT NULL DEFAULT 'info',
  summary text NOT NULL,
  links jsonb NOT NULL DEFAULT '[]'
);

-- Schema only — no channel implementations in this version (per L1)
CREATE TABLE notification_channel_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_type notification_channel_type NOT NULL,
  target text NOT NULL DEFAULT '',
  events notification_event_kind[] NOT NULL DEFAULT '{}'
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_channel_configs ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read briefings and activity events
CREATE POLICY "members read briefings" ON briefings
  FOR SELECT USING (is_member());

CREATE POLICY "members read activity_events" ON activity_events
  FOR SELECT USING (is_member());

-- Service role writes (summarizer) — no auth.uid() policy needed, service role bypasses RLS
-- No write policies for notification_channel_configs — prevents accidental use (per L3 gotcha)

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_briefings_generated_at ON briefings (generated_at DESC);
CREATE INDEX idx_activity_events_occurred_at ON activity_events (occurred_at DESC);

-- ============================================================
-- REALTIME
-- ============================================================
-- Enable realtime for live briefing updates in the dashboard
ALTER PUBLICATION supabase_realtime ADD TABLE briefings;
