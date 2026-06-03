import type {
  ResumeDispatcher,
  ResumeArgs,
  ResumeResult,
} from "../resume-dispatcher.js";
import type { ProbeResult } from "../notifier.js";

export class FakeResumeDispatcher implements ResumeDispatcher {
  readonly calls: ResumeArgs[] = [];
  /** effectIds already resumed/requeued at the worker (pre-seeded). */
  readonly applied = new Set<string>();
  /** scripted results per call (consumed FIFO); defaults to "acked". */
  results: ResumeResult[] = [];
  probeUnknown = false;

  async resume(args: ResumeArgs): Promise<ResumeResult> {
    this.calls.push(args);
    let result: ResumeResult;
    if (this.results.length > 0) {
      result = this.results.shift()!;
    } else {
      result = "acked";
    }
    if (result === "acked") this.applied.add(args.effectId);
    return result;
  }

  async status(effectId: string): Promise<ProbeResult> {
    if (this.probeUnknown) return "unknown";
    return this.applied.has(effectId) ? "applied" : "absent";
  }
}
