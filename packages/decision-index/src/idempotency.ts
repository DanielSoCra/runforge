import type { TransitionEvent, EffectKind } from "@runforge/decision-protocol";

/**
 * transition_key = <event>:<semantic_key> (spec §57). Two transitions that share
 * an external idempotency key stay distinct by event. The semantic key is the
 * natural per-event dedup token:
 *   notify:<channel>            opened:<viewer>
 *   answer_submitted:<response_idempotency_key>
 *   validated:<response_idempotency_key>
 *   write_response:<response_idempotency_key>
 *   resume_dispatch:<run_id>    resume_ack:<run_id>
 *   source_superseded:<new_id_or_etag>
 *   expire:<expires_at_epoch>   re_notify:<cycle>
 */
export function transitionKey(event: TransitionEvent, semanticKey: string): string {
  return `${event}:${semanticKey}`;
}

/**
 * Deterministic outbox / effect id = <decision_id>:<kind>:<semantic_key>.
 * Reconstructable from item state WITHOUT the outbox row, so a crash between
 * execute and commit is recoverable by probing the downstream with this id.
 */
export function effectId(decisionId: string, kind: EffectKind, semanticKey: string): string {
  return `${decisionId}:${kind}:${semanticKey}`;
}
