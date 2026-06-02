import type {
  SourceSink,
  WriteResponseArgs,
  WriteResult,
  CurrentEtagResult,
} from "../source-sink.js";
import type { ProbeResult } from "../notifier.js";

export class FakeSourceSink implements SourceSink {
  readonly calls: WriteResponseArgs[] = [];
  /** effectIds the source already contains (pre-seeded for crash-recovery tests). */
  readonly applied = new Set<string>();
  readonly superseded: { decision_id: string; newEtag: string }[] = [];
  /** scripted results per call (consumed FIFO); defaults to {status:"written"}. */
  results: WriteResult[] = [];
  /** when true, exists() returns "unknown" (indeterminate downstream). */
  probeUnknown = false;
  failTimes = 0;
  /**
   * Freshness-probe control (C2). By default the guard passes: currentEtag()
   * reports `equal` echoing the expected etag. Tests override:
   *  - `currentEtagResults`: scripted CurrentEtagResults (FIFO);
   *  - `currentEtagUnknown`: every probe returns `{status:"unknown"}`;
   *  - `changedSourceEtag`: every probe returns `{source_changed, <etag>}`.
   */
  currentEtagResults: CurrentEtagResult[] = [];
  currentEtagUnknown = false;
  changedSourceEtag: string | null = null;

  async writeResponse(args: WriteResponseArgs): Promise<WriteResult> {
    this.calls.push(args);
    let result: WriteResult;
    if (this.results.length > 0) {
      result = this.results.shift()!;
    } else if (this.failTimes > 0) {
      this.failTimes--;
      result = { status: "failed", error: "fake write failed" };
    } else {
      result = { status: "written" };
    }
    if (result.status === "written") this.applied.add(args.effectId);
    return result;
  }

  async exists(effectId: string): Promise<ProbeResult> {
    if (this.probeUnknown) return "unknown";
    return this.applied.has(effectId) ? "applied" : "absent";
  }

  async currentEtag(
    _sourceLocator: string,
    expectedSourceEtag?: string | null,
  ): Promise<CurrentEtagResult> {
    if (this.currentEtagResults.length > 0) return this.currentEtagResults.shift()!;
    if (this.currentEtagUnknown) return { status: "unknown" };
    if (this.changedSourceEtag !== null) {
      return { status: "source_changed", currentSourceEtag: this.changedSourceEtag };
    }
    // default: positively confirm equal to the expected etag.
    return { status: "equal", currentSourceEtag: expectedSourceEtag ?? undefined };
  }

  async markSuperseded(decision_id: string, newEtag: string): Promise<void> {
    this.superseded.push({ decision_id, newEtag });
  }
}
