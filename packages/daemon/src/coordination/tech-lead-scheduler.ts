// src/coordination/tech-lead-scheduler.ts — Scheduled Tech Lead analysis cycles with event debouncing
//
// Follows the po-agent.ts / review-scheduler.ts pattern: configurable interval,
// setTimeout-based scheduling, event debounce for batching triggers.
import type { CycleTrigger, SignalDigest, TechnicalProposal } from './tech-lead/schemas.js';
import { parseTechLeadOutput } from './tech-lead/session-output-parser.js';

export interface TechLeadSchedulerConfig {
  intervalMs: number;
  eventDebounceMs: number;
  proposalExpiryMs: number;
  lookbackWindowMs: number;
  maxEntriesPerSection: number;
}

export interface TechLeadSchedulerDeps {
  assembleDigest: (trigger: CycleTrigger, config: TechLeadSchedulerConfig) => Promise<SignalDigest>;
  spawnTechLeadSession: (digest: SignalDigest) => Promise<string>;
  storeProposals: (proposals: TechnicalProposal[]) => Promise<number>;
  sweepExpiredProposals: () => Promise<number>;
  routeToProtocol: (trigger: string) => Promise<void>;
}

export interface TechLeadSchedulerStatus {
  cyclesRun: number;
  running: boolean;
}

export interface TechLeadScheduler {
  start(): () => void;
  stop(): void;
  triggerEvent(trigger: CycleTrigger): void;
  getStatus(): TechLeadSchedulerStatus;
}

export function createTechLeadScheduler(
  deps: TechLeadSchedulerDeps,
  config: TechLeadSchedulerConfig,
): TechLeadScheduler {
  let cyclesRun = 0;
  let running = false;
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function runCycle(trigger: CycleTrigger): Promise<void> {
    if (running) return;
    running = true;

    // Cancel any pending scheduled timer so event-triggered cycles reset the cadence
    if (scheduledTimer !== null) {
      clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }

    try {
      // 1. Sweep expired proposals before analysis
      await deps.sweepExpiredProposals();

      // 2. Assemble signal digest
      const digest = await deps.assembleDigest(trigger, config);

      // 3. Spawn Tech Lead session with digest
      const rawOutput = await deps.spawnTechLeadSession(digest);

      // 4. Parse structured output
      const parsed = parseTechLeadOutput(rawOutput);
      if (!parsed.ok) {
        console.warn(`[tech-lead-scheduler] malformed session output: ${parsed.error}`);
        cyclesRun++;
        return;
      }

      // 5. Store proposals (if any)
      if (parsed.data.proposals.length > 0) {
        await deps.storeProposals(parsed.data.proposals);
      }

      // 6. Route protocol triggers (if any)
      for (const protocolTrigger of parsed.data.protocolTriggers) {
        await deps.routeToProtocol(protocolTrigger);
      }

      cyclesRun++;
    } catch (e) {
      console.error('[tech-lead-scheduler] cycle error:', e);
      cyclesRun++;
    } finally {
      running = false;
      scheduleNext();
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    scheduledTimer = setTimeout(() => {
      runCycle('scheduled').catch((e) => {
        console.error('[tech-lead-scheduler] unexpected error:', e);
      });
    }, config.intervalMs);
  }

  function start(): () => void {
    stopped = false;
    scheduleNext();
    return stop;
  }

  function stop(): void {
    stopped = true;
    if (scheduledTimer !== null) {
      clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function triggerEvent(trigger: CycleTrigger): void {
    if (stopped) return;
    // Debounce: reset timer on each event, fire once after debounce window
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runCycle(trigger).catch((e) => {
        console.error('[tech-lead-scheduler] event cycle error:', e);
      });
    }, config.eventDebounceMs);
  }

  function getStatus(): TechLeadSchedulerStatus {
    return { cyclesRun, running };
  }

  return { start, stop, triggerEvent, getStatus };
}
