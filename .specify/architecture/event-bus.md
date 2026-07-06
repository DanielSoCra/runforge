---
id: ARCH-EVENT-BUS
type: architecture
domain: concierge
status: draft
version: 1
layer: 2
references: FUNC-CONCIERGE-AWARENESS
---

# ARCH-EVENT-BUS — Event Bus

## Overview

The event-bus is a thin local relational queue that decouples the observer's event emission from the concierge's classification + reaction logic. Events flow: observer (writer) → `events` table → classifier (rule-based; deterministic) → outcome (`surface_card`, `slack_dm`, `silent_log`). The board-server tails the same table via SSE for real-time card updates.

## Schema

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                    -- e.g. "daemon_stuck", "manual_commit"
  source TEXT NOT NULL,                  -- "observer", "concierge", "runforge"
  payload TEXT NOT NULL,                 -- JSON
  classified_outcome TEXT,               -- NULL until classified; then surface_card|slack_dm|silent_log
  created_at INTEGER NOT NULL,           -- unix ms
  classified_at INTEGER,                 -- unix ms; NULL if pending
  acknowledged_at INTEGER                -- unix ms; NULL if not acknowledged (matters for re-surfacing prevention)
);

CREATE INDEX idx_events_pending ON events (classified_at) WHERE classified_at IS NULL;
CREATE INDEX idx_events_type ON events (type, created_at);
```

## Classification rules

Deterministic, rule-based. Implemented as a reviewed rule table, not an LLM call. Rules can be added or changed over time as the operator marks events as noise.

| Event type | Outcome | Reason |
|---|---|---|
| `daemon_stuck` | `surface_card` + `slack_dm` | needs operator decision |
| `daemon_run_completed` (success) | `silent_log` | autonomous success; nightly summary suffices |
| `daemon_run_completed` (with concerns) | `surface_card` | needs review |
| `daemon_unreachable` (first occurrence) | `slack_dm` | one-time alert |
| `daemon_unreachable` (subsequent) | `silent_log` | already alerted |
| `daemon_paused` | `slack_dm` | confirms manual pause |
| `daily_cost_threshold_crossed` | `slack_dm` | budget visibility |
| `manual_branch_created` | `silent_log` | manual session noise |
| `manual_commit` (on daemon-driven branch) | `silent_log` | daemon driving |
| `manual_commit` (on operator-driven branch) | `silent_log` | operator awareness, queryable on demand |
| `pr_opened` (by daemon) | `silent_log` | autonomous |
| `pr_opened` (manual) | `silent_log` | observable on demand |
| `slack_message_sent_to_external_channel` | `silent_log` | already audited |
| `confirmation_expired` | `slack_dm` | reminder |
| (unknown type) | `silent_log` | fail-closed: do not surface noise |

The classifier is pure: same event → same outcome. Re-classification is forbidden after the row is updated.

## SSE fan-out

`board-server` opens a long-lived local-store reader that polls `events` and `cards` for new rows since the last seen id. New rows fan out to all connected SSE clients. Polling interval: 250 ms (good enough for human-perceptible "live"; cheap on a local store).

## Retention

`events` rows are kept indefinitely; the table is small (an event is ~200 B, even at 1000 events/day = 70 MB/year). The consolidator job summarises events older than 7 days into the daily summary; raw rows stay for audit.

## Boundaries

- Classification is deterministic. The "classifier could be an LLM" idea is **out of scope** for v1; revisit only if rule explosion exceeds 50 cases.
- The event-bus does not implement retries, dead-letter queues, or partition keys. It is a single-writer-multi-reader queue.
- The bus does not do cross-process pubsub. Other processes see events via local-store read-after-write within ~250 ms.

## Failure modes

- **Observer writes a malformed event** — classifier throws, outcome is `errored`, board surfaces a ⚠️ card with the raw payload for operator inspection.
- **Classifier rule has a bug** — the buggy outcome is logged; the operator can manually mark the card / event acknowledged. The buggy rule is fixed in code.
