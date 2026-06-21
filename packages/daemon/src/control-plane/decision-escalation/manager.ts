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

export { RevealRefNotFoundError } from '@auto-claude/decision-index';

type DecisionIndexModule = typeof import('@auto-claude/decision-index');

export interface DecisionIndexManagerOptions {
  enabled: boolean;
  dbPath: string;
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

  constructor(opts: DecisionIndexManagerOptions) {
    this.#enabled = opts.enabled;
    this.#opts = opts;
  }

  isEnabled(): boolean {
    return this.#enabled;
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
      const writer = mod.createIndexWriter({
        dbPath: this.#opts.dbPath,
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
  ): { field: string; value: string } {
    return this.ledger().revealProtected(decisionId, ref, actor);
  }

  /** Graceful shutdown: close the underlying writable connection if open. */
  async close(): Promise<void> {
    if (this.#writer) {
      try {
        this.#writer.close();
      } catch {
        /* already closed */
      }
      this.#writer = null;
      this.#ledger = null;
    }
  }
}
