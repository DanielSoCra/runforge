import {
  createReleaseLedger,
  type ReleaseLedgerWriter,
} from "@runforge/release-ledger";

export interface ReleaseLedgerManagerOptions {
  enabled: boolean;
  databaseUrl?: string;
  opener?: () => Promise<ReleaseLedgerWriter>;
}

export class ReleaseLedgerManager {
  readonly #enabled: boolean;
  readonly #opts: ReleaseLedgerManagerOptions;
  #writer: ReleaseLedgerWriter | null = null;
  #broken = false;

  constructor(opts: ReleaseLedgerManagerOptions) {
    this.#enabled = opts.enabled;
    this.#opts = opts;
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  isAvailable(): boolean {
    return this.#enabled && !this.#broken && this.#writer !== null;
  }

  async init(): Promise<void> {
    if (!this.#enabled) return;
    try {
      const opener = this.#opts.opener ?? (() => {
        if (this.#opts.databaseUrl === undefined || this.#opts.databaseUrl === '') {
          throw new Error("release ledger databaseUrl not configured");
        }
        return createReleaseLedger({ databaseUrl: this.#opts.databaseUrl });
      });
      this.#writer = await opener();
    } catch (err) {
      this.#broken = true;
      console.error(
        `[release-ledger] release ledger unavailable (enabled but failed to open) — failing closed: ${String(err)}`,
      );
    }
  }

  ledger(): ReleaseLedgerWriter {
    if (!this.#enabled) throw new Error("release ledger disabled");
    if (this.#broken || !this.#writer) {
      throw new Error("release ledger unavailable");
    }
    return this.#writer;
  }

  async close(): Promise<void> {
    if (this.#writer) {
      try {
        await this.#writer.close();
      } catch {
        /* already closed */
      }
      this.#writer = null;
    }
  }
}
