import type { ProbeResult } from "./notifier.js";

/**
 * Structured write result (C1/I5). On a precondition failure the sink reports the
 * CONCRETE current source etag so the outbox records it as `superseded_by` —
 * never a fabricated `${old}-changed` string. `failed` carries an error message
 * for the audit/last_error trail.
 */
export type WriteResult =
  | { status: "written" }
  | { status: "precondition_failed"; currentSourceEtag: string }
  | { status: "failed"; error: string };

/** Result of probing the current source etag for the freshness guard (C2). */
export interface CurrentEtagResult {
  /**
   * `source_changed` — the locator resolved and its etag differs from the
   * expected one; carries the concrete current etag.
   * `equal` — positively confirmed equal to the expected etag.
   * `unknown` — could not be determined (network/parse error): fail-closed, the
   * outbox must NOT dispatch a resume on uncertainty.
   */
  status: "equal" | "source_changed" | "unknown";
  /** the concrete current source etag when known (equal/source_changed). */
  currentSourceEtag?: string;
}

export interface WriteResponseArgs {
  decision_id: string;
  /** redacted response payload pointer (never plaintext). */
  responseRef: string;
  expectedSourceEtag?: string | null;
  effectId: string;
  /** operational source locator (issue url / node id) — never redactable (C4). */
  sourceLocator: string;
  /**
   * C1 — the REDACTED, non-sensitive answer the sink may POST (chosen_option id
   * or a public/internal JSON answer value, serialized). NULL for a phi/secret
   * answer (the sink then posts an acknowledgement referencing the protected
   * store, NEVER plaintext).
   */
  responsePayloadJson?: string | null;
  /** protected:// ref for a sensitive answer (acknowledgement target). */
  answerRef?: string | null;
  /** true when the answer is phi/secret (post an ack, not plaintext). */
  hasProtectedAnswer: boolean;
}

/**
 * SourceSink — writes the answer back to the originating source, carrying the
 * expected etag. A precondition failure (source changed) routes to
 * source_superseded BEFORE any resume — never write a stale answer.
 */
export interface SourceSink {
  writeResponse(args: WriteResponseArgs): Promise<WriteResult>;
  /** probe by deterministic effect id — has this exact write already landed? */
  exists(effectId: string): Promise<ProbeResult>;
  /**
   * Probe the CURRENT source etag for the fail-closed freshness guard (C2).
   * `expectedSourceEtag` lets the sink compare positively; the result is
   * `equal` only when the current etag is confirmed equal.
   */
  currentEtag(sourceLocator: string, expectedSourceEtag?: string | null): Promise<CurrentEtagResult>;
  markSuperseded(decision_id: string, newEtag: string): Promise<void>;
}
