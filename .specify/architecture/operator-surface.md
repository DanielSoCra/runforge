---
id: ARCH-AC-OPERATOR-SURFACE
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-OPERATOR-SURFACE
---

# ARCH-AC-OPERATOR-SURFACE — Operator Surface

## Overview

The Operator Surface realizes FUNC-AC-OPERATOR-SURFACE's "one calm pane" as two cooperating components: a **Decision API** on the Daemon Control Plane that exposes the decision index's read model and answer path over HTTP, and the **Surface Client** (the dashboard) that renders the minimal inbox, briefing, and per-run drill-down against that API. This increment builds the Decision API, which is the strict prerequisite that unblocks the client — until now the decision index lived in-process to the Daemon and no out-of-process surface could read pending decisions or submit an answer. The API is a thin HTTP projection: it OWNS the request/response surface and the redaction boundary, but delegates every decision read to the index's read model and every answer to the decision ledger, introducing no second decision state machine and never communicating with the Operator directly.

> **Implementation sequencing (7a = READ, 7c = ANSWER).** The **read** surface (slice 7a) — the ranked pending-decisions inbox and the single-decision detail with server-side reveal — shipped first, complete and useful on its own. The **Answer Submission** behavior below is now implemented (slice 7c) **via the decision-escalation resume transport**: an answer must *resume the parked run*, and the proven resume engine (`resumeParkedRuns`, FUNC-AC-DECISION-ESCALATION) is driven by the decision-escalation DecisionResponse transport — NOT a direct `ledger.answer()`. Recording an answer through a second, parallel write path would persist an answer the resume loop never observes, stranding the run. So the Answer route POSTS a `DecisionResponse` write-back (an effect-marked `**DecisionResponse**` comment carrying the chosen option) on the gate issue, which the EXISTING `resumeParkedRuns` loop recognizes on its next tick and uses to drive `ledger.answer` + the lifecycle advance — with no change to the resume engine. The "delegated to the decision ledger's recorded answer transport" framing below is realized through that resume write-back, not a direct ledger call from the API.

## Data Model

The API introduces **no new persistent entities** — it projects entities the decision index (ARCH-AC-DECISION-ESCALATION) already owns. Three projections cross the HTTP boundary:

A **Pending Decision** is the ranked-inbox row the Operator sees by default: its identity, status, risk class, deployment, the focus/ranking score and the human-readable reason it ranks where it does, and its question, context, options, and recommended option. Fields that carry protected content (PHI/secret) appear here **as a class marker only** — the row names that a field is protected and its sensitivity class, but never the protected value, so the list can never leak protected content to a viewer.

A **Decision Detail** is the full single-decision view used when the Operator opens one decision: everything on the row plus the answer schema, source reference, and the timestamps and lifecycle markers. In the detail projection, protected fields additionally carry a **resolvable reference** to the protected value, so that a server-side resolver — running inside the trusted Control Plane, never the client — can reveal the value when rendering an authenticated detail view. The reference is present ONLY in the detail projection, never in the list.

An **Answer Submission** is the Operator's response to one decision: the decision identity and the chosen option, which must be one the decision offered AND one the resume transport carries (`approve`/`reject` — the values `resumeParkedRuns`/`parseCockpitAnswer` recognize). The answer is recorded by POSTING a `DecisionResponse` write-back on the gate issue, which the existing resume loop consumes to drive the ledger answer and the lifecycle advance — the API holds no direct write authority on the ledger. (Free-form answers and an explicit answerer identity are out of scope for this transport; answerer identity binding is a FUNC-AC-OPERATOR-AUTH follow-up — the resume loop records the answer as `operator`.)

## API Contract

The Decision API is mounted on the Daemon Control Plane's existing trusted-local control server (the same server that hosts status and run-control routes). It is reached only from the local host; **Operator authentication is enforced at the Surface Client (FUNC-AC-OPERATOR-AUTH), not re-implemented here** — the control server is a trusted-local surface, so the API's own contract is redaction and fail-safety, not session auth.

**List pending decisions** — Read the ranked inbox. Request: optional focus and filter inputs (status, risk class, deployment). Response: `200` with the array of Pending Decision projections, ordered by the index's ranking (highest priority first), protected fields reduced to class markers only. An empty inbox is a `200` with an empty array — the success state, not an error.

**Read decision detail** — Read one decision in full, with protected fields server-side-revealed. Request: the decision identity. Response: `200` with the Decision Detail projection when the decision exists; `404` when no such decision exists.

**Submit an answer** — Record the Operator's answer to one decision by posting the resume write-back. Request: the decision identity and a body carrying a `chosen_option`. Response: `200` once the `DecisionResponse` is posted (the resume loop then resumes the run); `400` when the body is not an object, omits `chosen_option`, names an option the decision did not offer, or names one the resume transport cannot carry (only `approve`/`reject`); `404` when the decision does not exist; `409` when the decision is not in an answerable state (only `notified`/`viewed`); `503` when the decision index is unavailable.

**Fail-safe across all three:** when the decision index is unavailable — disabled, broken at startup, or throwing on a read or write — the API responds `503` and never crashes the control server. The index being absent is a degraded-but-serving state, not a fatal one.

## System Boundaries

- The Decision API OWNS: the HTTP request/response surface for decisions on the Control Plane; the redaction boundary (list = class only, detail = server-side reveal); request-body validation (chosen-option XOR answer); and the fail-safe mapping of index errors to `503`.
- The Decision API READS: pending/ranked decisions and single-decision detail from the decision index's read model (ARCH-AC-DECISION-ESCALATION), via the Daemon's already-wired decision-index instance — the same instance the Daemon uses in-process. It does not open its own connection to the index store.
- The Decision API WRITES: nothing on the ledger directly. An Answer Submission is recorded by posting a `DecisionResponse` write-back on the gate issue; the existing `resumeParkedRuns` loop consumes it to drive the ledger answer and lifecycle advance. The API's only write is that resume write-back — it never calls `ledger.answer()` itself.
- The Decision API IS CONSUMED BY: the Surface Client (the dashboard), which renders the inbox, briefing, drill-down, and answer flow. The client is the only intended consumer; the API exposes no capability the owning decision-escalation behavior would not permit.
- The Decision API NEVER: introduces a second decision state machine (lifecycle is the index's alone); reveals protected content on the list surface; resolves protected references on the client (reveal is server-side, inside the Control Plane); merges, deploys, alters a pipeline phase, edits specifications or the vision; notifies or messages the Operator directly (delivery and notification remain the decision-escalation behavior's); or grants any steering action the owning capability would refuse.
- The trusted-local boundary: the control server binds to the local host and is not an internet-facing surface; cross-origin write protection on the control server applies to the answer route as to every other write route. The Operator's identity and session live at the Surface Client per FUNC-AC-OPERATOR-AUTH.

## Event Flows

**Operator loads the default surface (inbox):**
1. The Surface Client requests the pending-decisions list from the Decision API.
2. The API reads the ranked inbox from the decision index's read model, with the client's focus/filters applied.
3. The read model returns ranked rows with protected fields as class markers only; the API responds `200` with the rows in ranked order.
4. The client renders the inbox; an empty array renders the calm "nothing waits on you" state.

**Operator opens one decision (detail):**
1. The client requests the detail for a decision identity from the API.
2. The API reads the single-decision detail from the read model; protected fields carry resolvable references.
3. A server-side resolver inside the Control Plane reveals protected values for the authenticated detail render; the API responds `200` with the revealed detail. An unknown identity responds `404`.

**Operator answers a decision:**
1. The client submits a `chosen_option` to the API.
2. The API validates: the body is an object, the option is one the decision offered, the option is transport-carryable (`approve`/`reject`), the decision exists (`404` else) and is answerable (`notified`/`viewed`, `409` else); a malformed body or unsupported option responds `400` without posting anything.
3. The API posts a `DecisionResponse` write-back on the gate issue (the decision's own repo, resolved from its `source_url`) — never a direct ledger write.
4. The API responds `200` once the write-back is posted; the existing `resumeParkedRuns` loop recognizes it on its next tick and drives the ledger answer + lifecycle advance. A decision-index outage maps to `503`.

**Index unavailable mid-request:**
1. Any of the three routes calls the read model or ledger.
2. The index is disabled, broken at startup, or throws on the call.
3. The route catches the failure and responds `503`; the control server keeps serving its other routes — the failure is contained to the decision surface.

## Error Handling

**Index unavailable (disabled, broken, or throwing):** Respond `503` and keep the control server alive. The decision surface fails safe — it degrades to "unavailable" rather than crashing the Daemon's control plane or any other route. The client surfaces unavailability calmly; it never treats `503` as data loss.

**Unknown decision (detail or answer):** Respond `404`. A missing decision on the detail read is a `404`; on answer the read-model detail lookup returns nothing → `404`, so the client does not show a phantom success and nothing is posted.

**Malformed answer body:** Respond `400` when the body is not an object, omits `chosen_option`, names an option the decision did not offer, or names one the resume transport cannot carry (only `approve`/`reject`). Validation happens at the API boundary before anything is posted, so a bad request never produces a write-back.

**Non-answerable decision:** Respond `409` when the decision is not in an answerable state (only `notified`/`viewed` may be answered). Answered-once / replay idempotency is the resume loop + ledger's invariant downstream of the write-back (the deterministic effect marker keys it), never re-decided by the API.

**Redaction must not leak on error:** No error path widens disclosure. The list never carries protected values even under partial failure; a `503` or `404` carries only operational status, never protected content; and the server-side reveal for detail happens only on the success path inside the Control Plane.
