// packages/daemon/src/coordination/product-owner/interactive-session-context.ts
//
// Assemble interactive PO context, spawn multi-turn sessions, and manage records.

import { randomUUID } from 'crypto';
import { readdir } from 'fs/promises';
import { join } from 'path';
import type { SessionRuntime } from '../../session-runtime/runtime.js';
import { getFrozenPromptTemplate } from '../../session-runtime/runtime.js';
import { ok, err, type Result } from '../../lib/result.js';
import { writeJsonSafe } from '../../lib/json-store.js';
import {
  InteractiveSessionRecordSchema,
  InteractiveSessionContextSchema,
  type InteractiveSessionRecord,
  type InteractiveSessionContext,
  type SharedPOState,
} from './interactive-schemas.js';
import type { SharedPOStateStore } from './shared-po-state.js';

export interface InteractiveSessionDeps {
  stateStore: SharedPOStateStore;
  sessionsDir: string;
  promptsDir: string;
  runtime: SessionRuntime;
  loadActiveProposals: () => Promise<InteractiveSessionContext['activeProposals']>;
  loadBacklogSummary: () => Promise<InteractiveSessionContext['backlogSummary']>;
}

export interface InteractiveSessionOptions {
  timeoutSeconds?: number;
}

/**
 * Build the spawn variables that fill EVERY placeholder in
 * prompts/product-owner-interactive.md. The session runtime re-loads that
 * template by agent name (`def.name`) and substitutes `context.variables` — it
 * only falls back to `agentDef.systemPrompt` when the template file is missing.
 * So the assembled context MUST be threaded through here; baking it into
 * `systemPrompt` alone leaves `{{shared_po_state}}`, `{{active_proposals}}`, and
 * `{{backlog_summary}}` as literal placeholders in the prompt the PO model sees.
 * Keep the keys in sync with the `{{...}}` tokens in the template.
 */
export function buildInteractiveSpawnVariables(
  context: InteractiveSessionContext,
  sessionId: string,
): Record<string, string> {
  return {
    interactive_session_id: sessionId,
    shared_po_state: JSON.stringify(context.sharedState, null, 2),
    active_proposals: JSON.stringify(context.activeProposals, null, 2),
    backlog_summary: JSON.stringify(context.backlogSummary, null, 2),
  };
}

function renderInteractivePrompt(
  template: string,
  variables: Record<string, string>,
): string {
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

export async function assembleInteractiveContext(
  deps: InteractiveSessionDeps,
): Promise<Result<InteractiveSessionContext>> {
  try {
    const sharedState = await deps.stateStore.read();
    const activeProposals = await deps.loadActiveProposals();
    const backlogSummary = await deps.loadBacklogSummary();
    const context = { sharedState, activeProposals, backlogSummary };
    const parsed = InteractiveSessionContextSchema.safeParse(context);
    if (!parsed.success) {
      return err(new Error(`invalid interactive context: ${parsed.error.message}`));
    }
    return ok(parsed.data);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

export async function startInteractivePOSession(
  deps: InteractiveSessionDeps,
  options: InteractiveSessionOptions = {},
): Promise<Result<InteractiveSessionRecord>> {
  const contextResult = await assembleInteractiveContext(deps);
  if (!contextResult.ok) {
    return err(contextResult.error);
  }
  const context = contextResult.value;
  const sessionId = randomUUID();

  let template: string | undefined;
  try {
    template = getFrozenPromptTemplate('product-owner-interactive');
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  if (template === undefined) {
    return err(new Error('product-owner-interactive.md is not in the boot-frozen prompt cache'));
  }

  // Thread the assembled context into BOTH the spawn variables (the runtime
  // substitutes these into the reloaded template) and the fallback systemPrompt.
  const spawnVariables = buildInteractiveSpawnVariables(context, sessionId);
  const systemPrompt = renderInteractivePrompt(template, spawnVariables);
  const timeoutMs = (options.timeoutSeconds ?? 1800) * 1000;

  const agentDef = {
    name: 'product-owner-interactive',
    description: 'Interactive multi-turn Product Owner session',
    systemPrompt,
    allowedTools: ['Read', 'Glob', 'Grep'],
    modelOverride: 'claude-sonnet-4-6',
    maxTurns: 100,
    timeoutMs,
    budgetCap: 3,
  };

  const record: InteractiveSessionRecord = {
    id: sessionId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: 'explicit_close',
    sessionRuntimeId: sessionId,
    decisions: [],
    autonomousDecisionsReviewed: 0,
    needsDiscussionResolved: 0,
    summary: '',
  };

  try {
    await writeJsonSafe(join(deps.sessionsDir, `${sessionId}.json`), record);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  try {
    const result = await deps.runtime.spawnSession(
      'product-owner',
      { variables: spawnVariables },
      0,
      { agentDef },
    );

    if (!result.ok) {
      const errorRecord = {
        ...record,
        endedAt: new Date().toISOString(),
        endReason: 'error' as const,
        summary: `Session failed: ${result.error.message}`,
      };
      await writeJsonSafe(join(deps.sessionsDir, `${sessionId}.json`), errorRecord);
      return err(result.error);
    }

    const closedRecord: InteractiveSessionRecord = {
      ...record,
      endedAt: new Date().toISOString(),
      endReason: 'explicit_close',
      summary: extractSummary(result.value.output),
    };

    const parsedSummary = parseSessionOutput(result.value.output);
    if (parsedSummary.ok) {
      closedRecord.decisions = parsedSummary.value.decisions ?? [];
      closedRecord.autonomousDecisionsReviewed = parsedSummary.value.autonomousDecisionsReviewed ?? 0;
      closedRecord.needsDiscussionResolved = parsedSummary.value.needsDiscussionResolved ?? 0;
    }

    // Persist the operator's decisions back into SharedPOState before returning.
    // Writing the session record alone does NOT update shared-po-state.json, so
    // without this the resolved needsDiscussion items stay `pending` and resurface
    // on the next autonomous PO cycle. Read fresh, apply, and write-with-retry so
    // a concurrent autonomous write merges rather than clobbers.
    if (closedRecord.decisions.length > 0) {
      try {
        const currentState = await deps.stateStore.read();
        const updatedState = applySessionDecisionsToState(currentState, closedRecord);
        const writeResult = await deps.stateStore.writeWithRetry(
          updatedState,
          currentState.version,
        );
        if (!writeResult.ok) {
          console.warn(
            `[po-interactive] failed to persist session decisions to shared state: ${writeResult.error}`,
          );
        }
      } catch (e) {
        console.warn(
          `[po-interactive] error persisting session decisions: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    await writeJsonSafe(join(deps.sessionsDir, `${sessionId}.json`), closedRecord);
    return ok(closedRecord);
  } catch (e) {
    const errorRecord = {
      ...record,
      endedAt: new Date().toISOString(),
      endReason: 'error' as const,
      summary: `Session error: ${e instanceof Error ? e.message : String(e)}`,
    };
    await writeJsonSafe(join(deps.sessionsDir, `${sessionId}.json`), errorRecord).catch(() => {});
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

function extractSummary(output: string): string {
  try {
    const parsed = JSON.parse(output);
    if (typeof parsed.summary === 'string') return parsed.summary;
  } catch {
    // fall through
  }
  return output.slice(0, 1000);
}

function parseSessionOutput(output: string): Result<{
  decisions?: InteractiveSessionRecord['decisions'];
  autonomousDecisionsReviewed?: number;
  needsDiscussionResolved?: number;
  summary?: string;
}> {
  try {
    const json = JSON.parse(output);
    const result = InteractiveSessionRecordSchema.pick({
      decisions: true,
      autonomousDecisionsReviewed: true,
      needsDiscussionResolved: true,
      summary: true,
    }).safeParse(json);
    if (result.success) {
      return ok(result.data);
    }
    return err(new Error(result.error.message));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

export async function listSessionRecords(sessionsDir: string): Promise<InteractiveSessionRecord[]> {
  try {
    const files = await readdir(sessionsDir);
    const records: InteractiveSessionRecord[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await import('node:fs/promises').then((fs) => fs.readFile(join(sessionsDir, file), 'utf-8'));
        const parsed = JSON.parse(content);
        const result = InteractiveSessionRecordSchema.safeParse(parsed);
        if (result.success) {
          records.push(result.data);
        }
      } catch {
        // skip malformed records
      }
    }
    return records;
  } catch {
    return [];
  }
}

export async function hasActiveInteractiveSession(sessionsDir: string): Promise<boolean> {
  const records = await listSessionRecords(sessionsDir);
  return records.some((r) => r.endedAt === null);
}

export async function closeOrphanedSessions(sessionsDir: string): Promise<number> {
  const records = await listSessionRecords(sessionsDir);
  let closed = 0;
  for (const record of records) {
    if (record.endedAt === null) {
      const closedRecord: InteractiveSessionRecord = {
        ...record,
        endedAt: new Date().toISOString(),
        endReason: 'error',
        summary: record.summary || 'Orphaned session closed on startup/GC.',
      };
      await writeJsonSafe(join(sessionsDir, `${record.id}.json`), closedRecord).catch(() => {});
      closed++;
    }
  }
  return closed;
}

export function applySessionDecisionsToState(
  state: SharedPOState,
  record: InteractiveSessionRecord,
): SharedPOState {
  let updated = { ...state };
  for (const decision of record.decisions) {
    updated = {
      ...updated,
      needsDiscussion: updated.needsDiscussion.map((item) =>
        item.id === decision.itemId
          ? {
              ...item,
              status: 'decided' as const,
              operatorDecision: decision.decision,
              decisionTimestamp: decision.timestamp,
            }
          : item,
      ),
      lastUpdated: new Date().toISOString(),
    };
  }
  return updated;
}
