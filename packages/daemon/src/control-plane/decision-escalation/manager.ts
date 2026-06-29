/**
 * DecisionIndexManager — the daemon-owned lifecycle owner for the optional
 * decision-escalation index. It is the ONLY place the daemon loads the native
 * `@auto-claude/decision-index` package, and it does so via a DYNAMIC import
 * INSIDE the enabled branch only. A disabled deployment therefore never loads the
 * package's native (better-sqlite3) code — `init()` returns immediately.
 *
 * Fail-closed contract (fold design §gating):
 *   - flag OFF      -> `init()` is a no-op (no import); `ledger()` throws /disabled/.
 *   - flag ON, OK   -> `ledger()` returns a live DecisionLedger.
 *   - flag ON, broken (import / open / native-load failure) -> a `#broken` flag is
 *     set; `init()` does NOT throw (the daemon keeps running) but `ledger()` throws
 *     /unavailable/. Callers fail closed: an l2-gate resume stays parked rather
 *     than advancing on unconfirmed state.
 *
 * `import type` of the package keeps the static type surface without emitting a
 * runtime require; the runtime load is the `importer()` call alone.
 */
import { DecisionLedger } from './ledger.js';
import { LogNotifier, RecordingSourceSink, AckResumeDispatcher } from './adapters.js';
import type { IndexWriter, ProtectedStore } from '@auto-claude/decision-index';

type DecisionIndexModule = typeof import('@auto-claude/decision-index');

export interface DecisionIndexManagerOptions {
  enabled: boolean;
  /** Postgres URL the writer connects to (AUTO_CLAUDE_DATABASE_URL). */
  databaseUrl: string;
  protectedKey: string;
  protectedDir: string;
  /** clock injection (tests pin a fixed clock); defaults to wall-clock. */
  clock?: () => Date;
  /**
   * Override the dynamic import (tests inject the already-loaded module / a
   * throwing stub). Production uses the default dynamic `import()`.
   */
  importer?: () => Promise<DecisionIndexModule>;
}

export class DecisionIndexManager {
  readonly #enabled: boolean;
  readonly #opts: DecisionIndexManagerOptions;
  #writer: IndexWriter | null = null;
  #ledger: DecisionLedger | null = null;
  #broken = false;
  #runtimeDegraded = false;

  constructor(opts: DecisionIndexManagerOptions) {
    this.#enabled = opts.enabled;
    this.#opts = opts;
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  /**
   * Whether structured decision surfacing is actually USABLE right now (codex
   * Critical, spec §3.8): enabled AND not broken AND the ledger is built. Distinct
   * from isEnabled() (just the configured flag) — an enabled-but-broken index
   * (Postgres unreachable) must fail VISIBLY, not silently return success. The
   * phases gate structured surfacing on this, not isEnabled().
   */
  isAvailable(): boolean {
    return this.#enabled && !this.#broken && this.#ledger !== null;
  }

  /**
   * Runtime-degraded marker for governed deployments (PR1 first-use safety).
   * Set by the governed-only marking policy whenever an approval-path ledger
   * interaction fails for a governed deployment; cleared only by a successful
   * governed merge-decision op. Independent of #enabled/#broken.
   */
  markRuntimeDegraded(_reason: string): void {
    this.#runtimeDegraded = true;
  }

  clearRuntimeDegraded(): void {
    this.#runtimeDegraded = false;
  }

  isRuntimeDegraded(): boolean {
    return this.#runtimeDegraded;
  }

  /**
   * Initialize the index when enabled. Disabled -> immediate no-op (NEVER imports
   * native code). Enabled -> dynamic-import the package, open the writer with the
   * v1 adapters + protected key/dir, wrap it in a DecisionLedger. Any failure sets
   * the broken flag (fail-closed) but does NOT throw — the daemon keeps running.
   */
  async init(): Promise<void> {
    if (!this.#enabled) return;
    try {
      const mod = await (this.#opts.importer ??
        (() => import('@auto-claude/decision-index')))();
      const writer = await mod.createIndexWriter({
        databaseUrl: this.#opts.databaseUrl,
        protectedKey: this.#opts.protectedKey,
        protectedDir: this.#opts.protectedDir,
        notifier: new LogNotifier(),
        sourceSink: new RecordingSourceSink(),
        resumeDispatcher: new AckResumeDispatcher(),
        clock: this.#opts.clock ?? (() => new Date()),
      });
      this.#writer = writer;
      this.#ledger = new DecisionLedger(writer);
    } catch (err) {
      this.#broken = true;
      console.error(
        `[decision-escalation] index unavailable (enabled but failed to open) — failing closed: ${String(err)}`,
      );
    }
  }

  /**
   * The live ledger. Throws /disabled/ when the flag is off and /unavailable/ when
   * enabled-but-broken (fail-closed). Callers wrap in try/catch and stay parked on
   * `unavailable` rather than advancing on unconfirmed state.
   */
  ledger(): DecisionLedger {
    if (!this.#enabled) throw new Error('decision index disabled');
    if (this.#broken || !this.#ledger) throw new Error('decision index unavailable');
    return this.#ledger;
  }

  /**
   * The protected store owned by the live ledger. Mirrors `ledger()` semantics:
   * throws /disabled/ when the flag is off and /unavailable/ when enabled-but-broken.
   */
  protectedStore(): ProtectedStore {
    return this.ledger().protectedStore();
  }

  /**
   * Reveal a protected field's plaintext for a decision. Mirrors `ledger()`
   * fail-closed semantics: throws /disabled/ or /unavailable/ when the index is
   * off or broken. The underlying writer enforces the membership check and audit.
   */
  revealProtected(
    decisionId: string,
    ref: string,
    actor: string,
  ): Promise<{ field: string; value: string }> {
    return this.ledger().revealProtected(decisionId, ref, actor);
  }

  /** Graceful shutdown: close the underlying writer connection if open. */
  async close(): Promise<void> {
    if (this.#writer) {
      try {
        await this.#writer.close();
      } catch {
        /* already closed */
      }
      this.#writer = null;
      this.#ledger = null;
    }
  }
}

/**
 * The minimal runtime-marker surface the governed-only marking helpers depend on.
 * Both the real {@link DecisionIndexManager} and the test fake satisfy it, so the
 * helpers stay decoupled from the concrete manager (and from the test double).
 */
export interface RuntimeDegradable {
  markRuntimeDegraded(reason: string): void;
  clearRuntimeDegraded(): void;
}

/**
 * Governed-only marking wrapper for approval-path ledger interactions.
 * For a governed run (deploymentId !== undefined), an error from fn marks the
 * manager runtime-degraded; the error is re-thrown so the existing fail-closed
 * control flow is unchanged. For a non-governed run the marker is untouched and
 * fn is awaited verbatim.
 */
export async function withGovernedDecisionMarking<T>(
  manager: RuntimeDegradable | undefined,
  deploymentId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (deploymentId === undefined || manager === undefined) {
    return fn();
  }
  try {
    return await fn();
  } catch (e) {
    manager.markRuntimeDegraded(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/**
 * Mark the manager runtime-degraded only for a governed run (no-op when the run
 * is non-governed OR no manager is present — a disabled index passes `undefined`).
 */
export function markRuntimeDegradedIfGoverned(
  manager: RuntimeDegradable | undefined,
  deploymentId: string | undefined,
  reason: string,
): void {
  if (deploymentId !== undefined && manager !== undefined) {
    manager.markRuntimeDegraded(reason);
  }
}

/**
 * Clear the runtime-degraded marker only for a governed run. The marker is
 * cleared EXCLUSIVELY by a successful governed merge-decision op; a non-governed
 * (deploymentId === undefined) success is a no-op and never clears a marker a
 * governed failure set.
 */
export function clearRuntimeDegradedIfGoverned(
  manager: RuntimeDegradable | undefined,
  deploymentId: string | undefined,
): void {
  if (deploymentId !== undefined && manager !== undefined) {
    manager.clearRuntimeDegraded();
  }
}
