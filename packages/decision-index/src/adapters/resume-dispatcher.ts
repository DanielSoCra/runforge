import type { ProbeResult } from "./notifier.js";

export type ResumeMode = "mid_run" | "requeue";
export type ResumeResult = "acked" | "unreachable" | "failed";

export interface ResumeArgs {
  decision_id: string;
  mode: ResumeMode;
  effectId: string;
  /** §7 durable worker metadata used to address the run. */
  wake_command?: string | null;
  requeue_command?: string | null;
  work_request_ref?: string | null;
}

/**
 * ResumeDispatcher — wakes (mid_run) or requeues a worker. Idempotent at the
 * worker (the woken worker re-reads decision_responses + the deterministic id,
 * so a double-dispatch is a no-op). `status` probes whether a given effect id
 * has already resumed/requeued the run.
 */
export interface ResumeDispatcher {
  resume(args: ResumeArgs): Promise<ResumeResult>;
  status(effectId: string): Promise<ProbeResult>;
}
