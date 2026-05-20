/**
 * Briefing Summarizer — standalone process.
 *
 * Runs on a configurable interval (default 5 min), collects system signals,
 * calls Claude Haiku for structured summarization, and writes results.
 *
 * NOT part of Next.js or the daemon — this is a separate Node.js process.
 */

import { execFileSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { collectSignals } from './signals.js';
import { buildSignalPrompt, briefingTool } from './prompt.js';
import { extractActivityEvents } from './events.js';
import { log } from './log.js';
import { createCycleRunner } from './cycle-runner.js';
import { startHealthServer } from './health-server.js';
import {
  createBriefingDataBackend,
  readBriefingDataBackendKind,
  validateBriefingDataBackendEnv,
} from './data/backend.js';
import type { BriefingDataBackend, BriefingOutput } from './data/types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const INTERVAL_MS = Number(process.env.SUMMARIZER_INTERVAL_MS) || 5 * 60 * 1000;
const HEALTH_PORT = Number(process.env.HEALTH_PORT) || 3099;
const HEALTH_MAX_CYCLE_MS =
  Number(process.env.HEALTH_MAX_CYCLE_MS) ||
  Math.max(INTERVAL_MS * 2, 10 * 60 * 1000);
const DAEMON_URL = process.env.DAEMON_URL ?? 'http://daemon:3847';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------

function validateEnv(): void {
  const errors: string[] = [];
  if (!ANTHROPIC_API_KEY) {
    errors.push('Missing required environment variables: ANTHROPIC_API_KEY');
  }

  try {
    validateBriefingDataBackendEnv();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    log('error', errors.join('; '));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function createAnthropicClient(): Anthropic {
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

// ---------------------------------------------------------------------------
// Repo URL (for constructing full GitHub PR links)
// ---------------------------------------------------------------------------

function getRepoUrl(): string | null {
  try {
    const raw = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();

    // SSH format: git@github.com:org/repo.git
    const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;

    // HTTPS format: https://github.com/org/repo.git
    const httpsMatch = raw.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return `https://${httpsMatch[1]}/${httpsMatch[2]}`;

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Structured model call
// ---------------------------------------------------------------------------

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
// Check notification channels (stub)
// ---------------------------------------------------------------------------

async function checkNotificationChannels(
  backend: BriefingDataBackend,
): Promise<void> {
  try {
    const count = await backend.countNotificationChannels();
    if (count === 0) {
      // No channels configured — skip dispatch (expected current behavior)
      return;
    }
    // Future: dispatch attention items to configured channels
    log(
      'info',
      `${count} notification channel(s) configured — dispatch not yet implemented`,
    );
  } catch (error) {
    log(
      'warn',
      `Failed to query notification channels: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main summarizer cycle
// ---------------------------------------------------------------------------

async function runCycle(
  backend: BriefingDataBackend,
  anthropic: Anthropic,
  repoUrl: string | null,
): Promise<void> {
  const cycleStart = Date.now();
  log('info', 'Starting summarizer cycle');

  // 1. Get previous briefing's generated_at (or 24h ago)
  const previous = await backend.getPreviousBriefing();
  const since =
    previous?.generated_at ??
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  log('info', `Collecting signals since ${since}`);

  // 2. Collect all signals in parallel
  const signals = await collectSignals(backend, DAEMON_URL, since);
  log(
    'info',
    `Collected: ${signals.runs.length} runs, ${signals.gitLog.length} commits, daemon=${signals.daemonStatus ? 'ok' : 'unavailable'}, gaps=${signals.gaps.length}`,
  );

  // 3. Build prompt
  const signalPrompt = buildSignalPrompt(signals, previous);

  // 4. Call model
  const briefingOutput = await callModel(anthropic, signalPrompt);
  if (!briefingOutput) {
    log(
      'warn',
      'Model call failed or returned invalid output — skipping this cycle',
    );
    return;
  }
  log('info', `Briefing generated: "${briefingOutput.status_line}"`);

  // 5. Write briefing
  await backend.writeBriefing(briefingOutput, signals);
  log('info', 'Briefing written');

  // 6. Extract and write activity events
  const events = extractActivityEvents(
    signals,
    previous?.signal_snapshot ?? null,
    repoUrl,
  );
  await backend.writeActivityEvents(events);
  log('info', `Wrote ${events.length} activity event(s)`);

  // 7. Check notification channels (stub)
  await checkNotificationChannels(backend);

  const elapsed = Date.now() - cycleStart;
  log('info', `Cycle complete in ${elapsed}ms`);
}

// ---------------------------------------------------------------------------
// Entry point with SIGTERM handling
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  const backend = createBriefingDataBackend();
  const anthropic = createAnthropicClient();
  const repoUrl = getRepoUrl();
  const backendKind = readBriefingDataBackendKind();

  log(
    'info',
    `Briefing summarizer starting (interval=${INTERVAL_MS}ms, daemon=${DAEMON_URL}, repo=${repoUrl ?? 'unknown'}, backend=${backendKind})`,
  );

  const runner = createCycleRunner(() => runCycle(backend, anthropic, repoUrl));
  const healthServer = await startHealthServer(HEALTH_PORT, {
    getStatus: runner.getStatus,
    maxCycleMs: HEALTH_MAX_CYCLE_MS,
  });
  log('info', `Health endpoint listening on 127.0.0.1:${HEALTH_PORT}/health`);

  // Run first cycle immediately
  await runner.wrappedCycle();

  // Set up interval
  const intervalId = setInterval(() => void runner.wrappedCycle(), INTERVAL_MS);

  // SIGTERM handler: clear interval, wait for in-flight, exit
  const handleShutdown = async (signal: string): Promise<void> => {
    clearInterval(intervalId);
    try {
      await runner.shutdown(signal);
    } finally {
      await backend.close?.();
      healthServer.close();
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  process.on('SIGINT', () => void handleShutdown('SIGINT'));
}

main().catch((err) => {
  log('error', `Fatal error: ${String(err)}`);
  process.exit(1);
});
