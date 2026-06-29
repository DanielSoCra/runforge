// B4 truthful /health (first-use safety net) — the pure 503 / 200-degraded /
// 200-ok evaluator. The daemon gathers a HealthSignals snapshot from its live
// state (getStatus + decision-index marker + watchdog + alert-channel flag) and
// calls this; the control server maps the result onto the HTTP status code.
//
// Mapping (Codex-adjudicated, spec §B4):
//  - 503 (unsafe / no-progress): hard-stuck streak, watchdog stall, a governed
//    daemon whose decision index has failed at runtime, a repo tick stale beyond
//    threshold while not paused/draining, and any SAFETY auto-pause. An untagged
//    pause defaults to the cautious safety interpretation (→ 503).
//  - 200 degraded:true (observable but intentional/transient): manual pause,
//    draining, startup-degraded-retrying, governed-without-alert-channel (B2),
//    a transient alert-channel send failure.
//  - 200 ok:true: everything else. A non-governed daemon's decision-index state
//    is NEVER a health signal (legacy integrate is normal there).

export type PauseReason =
  | 'manual'
  | 'budget'
  | 'stuck'
  | 'tick-error'
  | 'runtime-source';

/** A SAFETY pause (→ 503). Manual pause is intentional and maps to 200-degraded. */
const SAFETY_PAUSE_REASONS: ReadonlySet<PauseReason> = new Set<PauseReason>([
  'budget',
  'stuck',
  'tick-error',
  'runtime-source',
]);

export interface HealthSignals {
  /** A deployment profile is configured — the merge-governance boundary. */
  isGoverned: boolean;
  /** Governed approval-path op failed at runtime (decisionManager marker). */
  indexRuntimeDegraded: boolean;
  /** Index enabled but unreachable right now (isEnabled() && !isAvailable()). */
  indexEnabledButUnavailable: boolean;
  paused: boolean;
  pauseReason: PauseReason | null;
  draining: boolean;
  consecutiveStuckCount: number;
  maxConsecutiveStuck: number;
  /** The B5 watchdog detected a run-stall or tick-stall. */
  watchdogStalled: boolean;
  /**
   * A repo poll has been in flight past the watchdog idle-timeout — the same
   * condition the tick-stall watchdog flags, read on demand so /health can report
   * 503 immediately (before the watchdog's next interval tick). Aligned with the
   * watchdog threshold so the two signals never disagree.
   */
  repoTickStale: boolean;
  /** Startup config fetch is still failing and retrying (degraded boot window). */
  startupDegradedRetrying: boolean;
  /** Governed deployment booted with no configured alert channel (B2). */
  alertChannelDegraded: boolean;
  /** A recent alert-channel send failed transiently. */
  transientAlertFailure: boolean;
}

export interface HealthResult {
  ok: boolean;
  degraded: boolean;
  reason: string | null;
}

function unhealthy(reason: string): HealthResult {
  return { ok: false, degraded: true, reason };
}

function degraded(reason: string): HealthResult {
  return { ok: true, degraded: true, reason };
}

export function evaluateHealth(s: HealthSignals): HealthResult {
  // --- 503: unsafe / no forward progress ---
  if (s.maxConsecutiveStuck > 0 && s.consecutiveStuckCount >= s.maxConsecutiveStuck) {
    return unhealthy(`stuck-threshold-reached:${s.consecutiveStuckCount}`);
  }
  if (s.watchdogStalled) {
    return unhealthy('watchdog-stall');
  }
  if (s.isGoverned && (s.indexRuntimeDegraded || s.indexEnabledButUnavailable)) {
    return unhealthy('decision-index-unavailable');
  }
  // A SAFETY pause (or an untagged pause, treated cautiously) is unhealthy; a
  // MANUAL pause is intentional and handled in the degraded group below.
  if (
    s.paused &&
    (s.pauseReason === null || SAFETY_PAUSE_REASONS.has(s.pauseReason))
  ) {
    return unhealthy(`safety-pause:${s.pauseReason ?? 'untagged'}`);
  }
  if (s.repoTickStale && !s.paused && !s.draining) {
    return unhealthy('repo-tick-stale');
  }

  // --- 200 degraded: observable but intentional/transient ---
  if (s.paused && s.pauseReason === 'manual') {
    return degraded('manual-pause');
  }
  if (s.draining) {
    return degraded('draining');
  }
  if (s.alertChannelDegraded) {
    return degraded('alert-channel-degraded');
  }
  if (s.startupDegradedRetrying) {
    return degraded('startup-degraded-retrying');
  }
  if (s.transientAlertFailure) {
    return degraded('alert-channel-send-failure');
  }

  // --- 200 ok ---
  return { ok: true, degraded: false, reason: null };
}
