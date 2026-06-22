---
id: ARCH-AC-RELEASE
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-RELEASE
---

# ARCH-AC-RELEASE — Operator-Approved Production Release

## Overview

A **Release Tool**, invoked only by the Operator, computes what has been accepted since the last recorded release, renders a **preview** of what promoting would change, and — on the Operator's explicit approval — promotes the **Running Production System** to the approved revision and appends a **Release Record**. A preview (dry run) never mutates the running system; a promotion that fails restores the prior running state, so production is never left half-promoted.

## Data Model

A **Release** records the released revision, a summary of what changed since the prior release, the approver, and the time. Releases form an append-only history.

The **Release Log** is the durable, append-only store of Releases — the source of truth for what is live; it is never rewritten.

The **Running Production System** is the live instance; promoting it means pointing it at the approved revision and restarting it under its supervisor.

The **Ready State** is the canonical accepted-and-verified line of work a release promotes from; the Release Tool only reads it, never alters it.

## API Contract

- **preview()** — Operator-invoked. Computes the accepted work since the last Release and the promotion it would perform; returns a preview. Mutates nothing (no record, no promotion, no restart). Outcome: the preview.
- **release(approval)** — Operator-invoked with explicit approval. Verifies the Ready State is clean and current, promotes the Running Production System to the approved revision and restarts it, confirms it is live, and only THEN records a Release in the Log. Outcome: *released* (live + recorded) or *failed* (prior running state intact, nothing recorded as live).
- There is no autonomous release path: a Release occurs only through an Operator-invoked `release(approval)`.

## System Boundaries

The **Release Tool** is Operator-invoked only and never runs autonomously; it is the sole initiator of a promotion and the sole writer of the Release Log.

The **Release Log** is append-only and is the source of truth for the live revision; it is never rewritten.

The **Running Production System** is changed only by an approved `release`; `preview` never touches it. Its supervisor keeps the prior instance running until a promotion succeeds.

The **Ready State** is read-only to the Release Tool — releasing promotes from it, never alters it.

## Event Flows

1. The Operator runs **preview**. The tool reads the Ready State and the last Release, computes what is new and the promotion plan, and renders it. Nothing is recorded, promoted, or restarted.
2. The Operator runs **release** with approval. The tool re-verifies the Ready State is clean and current, promotes the Running Production System to the approved revision and restarts it under its supervisor, confirms it is live, and only then appends the Release to the Log — so a promotion that fails is never recorded as a release.
3. If any step of a promotion fails, the tool surfaces the failure and the supervisor keeps the prior instance running; the attempt is not recorded as a successful release and production is not left half-promoted.

## Error Handling

- **Unclean or stale Ready State** — the tool refuses to release and reports why; nothing is promoted.
- **Promotion or restart fails** — the prior running instance is retained by its supervisor, the failure is surfaced, and the attempt is not recorded as a successful release.
- **No approval** — `release` refuses without explicit Operator approval; only `preview` runs.
- **Release Log unavailable** — the tool refuses to promote, since a release that cannot be recorded would make the live state unknowable.
