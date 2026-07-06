---
id: ARCH-TOOL-REGISTRY
type: architecture
domain: concierge
status: draft
version: 1
layer: 2
references: FUNC-CONCIERGE-CORE
---

# ARCH-TOOL-REGISTRY — Tool Registry

## Overview

The tool registry is the canonical list of tools the concierge LLM may call. It serves three audiences: (1) the LLM, which receives a JSON-schema-shaped tool definition for each entry; (2) the tool router, which dispatches `tool_use` calls to the registered handler; (3) the operator, who reads the registry to audit "what can the bot actually do?". Every tool — including those wrapping subsystems whose full L1 specs are deferred — must have a registry entry before the LLM can call it.

## Registry shape

```typescript
type BlastRadius = 'safe' | 'medium' | 'high';

interface ToolEntry {
  name: string;                          // unique; namespaced (ac_, sb_, gh_, cal_, ...)
  description: string;                    // shown to LLM; ≤200 chars
  argsSchema: JSONSchema;                 // strict; reject additionalProperties
  handler: (args: unknown) => Promise<unknown>;
  blastRadius: BlastRadius;
  audit: 'always' | 'on_error_only';
  cacheable: boolean;                     // identity over args within 60 s
  subsystem: string;                      // e.g. 'runforge', 'knowledge-vault'
  governingSpecId: string | null;         // L1 spec governing the subsystem; null until spec authored
  status: 'enabled' | 'disabled' | 'experimental';
}
```

## Initial entries (Phase 0 placeholder set)

These minimal entries live in `packages/concierge/src/tools/registry.ts` (Phase 1+; documented here for reference).

| Name | Subsystem | Blast | Confirm? | Notes |
|---|---|---|---|---|
| `ac_run` | runforge | medium | no | `{issue: number}` → `{run_id: string}` |
| `ac_status` | runforge | safe | no | `{}` → daemon status snapshot |
| `ac_pause` | runforge | medium | no | pause daemon |
| `ac_unstuck` | runforge | medium | no | `{issue: number}` |
| `ac_merge_to_main` | runforge | high | yes | always confirm |
| `sb_read` | knowledge-vault | safe | no | `{path: string}` |
| `sb_search` | knowledge-vault | safe | no | `{query: string}` |
| `sb_append_inbox` | knowledge-vault | medium | no | `{slug, body}` → 00-inbox/ |
| `sb_write_decision` | knowledge-vault | medium | no | project notes only |
| `sb_write_client` | knowledge-vault | high | yes | always confirm (20-Areas/clients/) |
| `gh_search` | gh | safe | no | read-only query |
| `gh_comment` | gh | medium | no | non-issue comments below |
| `cal_read` | calendar | safe | no | read events |
| `mail_draft` | email | medium | no | draft only |
| `mail_send` | email | high | yes | always confirm |
| `slack_send_dm` | slack | safe | no | to operator only |
| `slack_send_channel` | slack | high | yes | always confirm |
| `web_fetch` | web | safe | no | URL → text |
| `obs_recent_activity` | observer | safe | no | last N hours |
| `obs_daemon_state` | observer | safe | no | cached daemon status |

The registry is the source of truth. The tool definitions exposed to the LLM are derived from this table; the `name` and `description` are sent verbatim, the args schema is rendered to JSON Schema for the Anthropic API.

## Versioning

When a tool's argsSchema changes incompatibly, the entry's `name` is bumped (e.g. `ac_run` → `ac_run_v2`). The old name remains as `disabled` long enough that any in-flight tool_use from a stale LLM context still resolves to a deprecation message.

## Operator audit

The operator can list all tools via the slash command `/tools` in Slack — the slack-adapter renders the registry as a Block Kit message grouped by subsystem and blast radius.

## Boundaries

- This spec defines REGISTRY SHAPE, not subsystem behaviour. Each subsystem's behaviour lives in its own L1 (existing `FUNC-AC-*` for runforge; deferred for others until non-trivial behaviour emerges).
- Confirmation flow (how confirm messages are rendered, how taps are routed) lives in `ARCH-CONFIRMATION-LIFECYCLE`.
- Skill files (Hermes-style distilled trajectories) are NOT tools in this registry. They are scripts the LLM calls via a special `run_skill` tool; the registry has one entry for `run_skill` that takes a skill-id arg.

## Failure modes

- **Tool name collision on registration** — startup throws; concierge-core refuses to start.
- **argsSchema validation failure** — router returns `{error: "invalid args"}` to the LLM; no handler is invoked.
- **Handler runtime exception** — router returns `{error}`; LLM sees the error verbatim.
