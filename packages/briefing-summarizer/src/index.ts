/**
 * Briefing Summarizer — standalone process.
 *
 * Runs on a configurable interval (default 5 min), collects system signals,
 * calls Claude Haiku for structured summarization, and writes results to Supabase.
 *
 * NOT part of Next.js or the daemon — this is a separate Node.js process.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { collectSignals, type SignalResult } from './signals.js';
import { buildSignalPrompt, briefingTool, type PreviousBriefing } from './prompt.js';
import { extractActivityEvents, type PreviousSnapshot } from './events.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const INTERVAL_MS = Number(process.env.SUMMARIZER_INTERVAL_MS) || 5 * 60 * 1000;
const DAEMON_URL = process.env.DAEMON_URL ?? 'http://daemon:3847';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const missing: string[] = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');

  if (missing.length > 0) {
    log('error', `Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function createSupabaseClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

function createAnthropicClient(): Anthropic {
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

// ---------------------------------------------------------------------------
// Previous briefing query
// ---------------------------------------------------------------------------

async function getPreviousBriefing(
  supabase: SupabaseClient,
): Promise<(PreviousBriefing & { signal_snapshot: PreviousSnapshot }) | null> {
  const { data, error } = await supabase
    .from('briefings')
    .select('status_line, changes, attention, forecast, signal_snapshot, generated_at')
    .order('generated_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as PreviousBriefing & { signal_snapshot: PreviousSnapshot };
}

// ---------------------------------------------------------------------------
// Structured model call
// ---------------------------------------------------------------------------

interface BriefingOutput {
  status_line: string;
  changes: unknown[];
  attention: unknown[];
  forecast: string;
}

async function callModel(
  anthropic: Anthropic,
  signalPrompt: string,
): Promise<BriefingOutput | null> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools: [briefingTool],
      tool_choice: { type: 'tool', name: 'produce_briefing' },
      messages: [{ role: 'user', content: signalPrompt }],
    });

    // Extract tool_use block
    const toolBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (!toolBlock) {
      log('error', 'Model response did not contain a tool_use block');
      return null;
    }

    const input = toolBlock.input as Record<string, unknown>;

    // Validate required fields
    if (
      typeof input.status_line !== 'string' ||
      !Array.isArray(input.changes) ||
      !Array.isArray(input.attention) ||
      typeof input.forecast !== 'string'
    ) {
      log('error', 'Model output missing required fields');
      return null;
    }

    return {
      status_line: input.status_line,
      changes: input.changes,
      attention: input.attention,
      forecast: input.forecast,
    };
  } catch (err) {
    log('error', `Model call failed: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write briefing to Supabase
// ---------------------------------------------------------------------------

async function writeBriefing(
  supabase: SupabaseClient,
  briefing: BriefingOutput,
  signalSnapshot: SignalResult,
): Promise<void> {
  const { error } = await supabase.from('briefings').insert({
    status_line: briefing.status_line,
    changes: briefing.changes,
    attention: briefing.attention,
    forecast: briefing.forecast,
    signal_snapshot: signalSnapshot,
    generated_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to write briefing: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Write activity events to Supabase
// ---------------------------------------------------------------------------

async function writeActivityEvents(
  supabase: SupabaseClient,
  events: { occurred_at: string; event_type: string; severity: string; summary: string; links: unknown[] }[],
): Promise<void> {
  if (events.length === 0) return;

  const { error } = await supabase.from('activity_events').insert(events);

  if (error) {
    throw new Error(`Failed to write activity events: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Check notification channels (stub)
// ---------------------------------------------------------------------------

async function checkNotificationChannels(supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from('notification_channel_configs')
    .select('id')
    .limit(1);

  if (error) {
    log('warn', `Failed to query notification channels: ${error.message}`);
    return;
  }

  if (!data || data.length === 0) {
    // No channels configured — skip dispatch (expected current behavior)
    return;
  }

  // Future: dispatch attention items to configured channels
  log('info', `${data.length} notification channel(s) configured — dispatch not yet implemented`);
}

// ---------------------------------------------------------------------------
// Main summarizer cycle
// ---------------------------------------------------------------------------

async function runCycle(
  supabase: SupabaseClient,
  anthropic: Anthropic,
): Promise<void> {
  const cycleStart = Date.now();
  log('info', 'Starting summarizer cycle');

  // 1. Get previous briefing's generated_at (or 24h ago)
  const previous = await getPreviousBriefing(supabase);
  const since = previous?.generated_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  log('info', `Collecting signals since ${since}`);

  // 2. Collect all signals in parallel
  const signals = await collectSignals(supabase, DAEMON_URL, since);
  log('info', `Collected: ${signals.runs.length} runs, ${signals.gitLog.length} commits, daemon=${signals.daemonStatus ? 'ok' : 'unavailable'}, gaps=${signals.gaps.length}`);

  // 3. Build prompt
  const signalPrompt = buildSignalPrompt(signals, previous);

  // 4. Call model
  const briefingOutput = await callModel(anthropic, signalPrompt);
  if (!briefingOutput) {
    log('warn', 'Model call failed or returned invalid output — skipping this cycle');
    return;
  }
  log('info', `Briefing generated: "${briefingOutput.status_line}"`);

  // 5. Write briefing to Supabase
  await writeBriefing(supabase, briefingOutput, signals);
  log('info', 'Briefing written to Supabase');

  // 6. Extract and write activity events
  const events = extractActivityEvents(signals, previous?.signal_snapshot ?? null);
  await writeActivityEvents(supabase, events);
  log('info', `Wrote ${events.length} activity event(s)`);

  // 7. Check notification channels (stub)
  await checkNotificationChannels(supabase);

  const elapsed = Date.now() - cycleStart;
  log('info', `Cycle complete in ${elapsed}ms`);
}

// ---------------------------------------------------------------------------
// Entry point with SIGTERM handling
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const supabase = createSupabaseClient();
  const anthropic = createAnthropicClient();

  log('info', `Briefing summarizer starting (interval=${INTERVAL_MS}ms, daemon=${DAEMON_URL})`);

  let inFlight: Promise<void> | null = null;
  let shuttingDown = false;

  const wrappedCycle = async (): Promise<void> => {
    if (shuttingDown) return;
    try {
      inFlight = runCycle(supabase, anthropic);
      await inFlight;
    } catch (err) {
      log('error', `Cycle failed: ${String(err)}`);
    } finally {
      inFlight = null;
    }
  };

  // Run first cycle immediately
  await wrappedCycle();

  // Set up interval
  const intervalId = setInterval(() => void wrappedCycle(), INTERVAL_MS);

  // SIGTERM handler: clear interval, wait for in-flight, exit
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `Received ${signal}, shutting down gracefully...`);
    clearInterval(intervalId);

    if (inFlight) {
      log('info', 'Waiting for in-flight cycle to complete...');
      try {
        await inFlight;
      } catch {
        // Already logged in wrappedCycle
      }
    }

    log('info', 'Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log('error', `Fatal error: ${String(err)}`);
  process.exit(1);
});
