import type { Notifier, NotifyArgs, ProbeResult } from "../notifier.js";

export class FakeNotifier implements Notifier {
  readonly calls: NotifyArgs[] = [];
  /** effectIds the fake should report as already-applied on probe (pre-seeded). */
  readonly applied = new Set<string>();
  mode: "sent" | "failed" = "sent";

  async notify(args: NotifyArgs): Promise<"sent" | "failed"> {
    this.calls.push(args);
    if (this.mode === "sent") this.applied.add(args.effectId);
    return this.mode;
  }

  async probe(effectId: string): Promise<ProbeResult> {
    return this.applied.has(effectId) ? "applied" : "absent";
  }
}
