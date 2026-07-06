---
id: FUNC-AC-KNOWLEDGE-SYNC
type: functional
domain: runforge
status: draft
version: 1
layer: 1
---

# FUNC-AC-KNOWLEDGE-SYNC — External-Knowledge Ingress (Advisory-Only)

## Problem Statement

The organization accumulates hard-won knowledge — mistakes, recurring patterns, conventions — outside the platform, in a separate knowledge collection the Operator maintains by hand. Re-teaching that knowledge inside the platform one entry at a time wastes the Operator's attention, and letting it drift out of date wastes the knowledge. So the platform offers a third learning channel: it may ingest the Operator's external knowledge collection to inform working sessions, alongside the two channels it already has (the improvements the Operator makes to skills and instructions, and what the platform infers from the Operator's own repeated decisions).

But an externally edited collection is a trust hazard the other two channels do not carry. Anyone who can edit an entry in that collection — or a single careless or stale entry — can attempt to steer what every autonomous run believes. The danger is not that ingested knowledge informs a draft; that is the point. The danger is that an ingested entry asserting "this kind of change is safe," or "this finding can be dismissed," could shape a risk judgment, a review verdict, an escalation decision, a specification-content approval, or a release — turning an entry edited outside the platform's verification machinery into a way to talk the platform past its own safety boundaries. A claim of safety that rests on the hope that ingested text is only ever used advisably is not a boundary at all. This channel therefore exists only if that influence is made structurally impossible, and stays switched off until it is.

## Actors

- **Operator** — maintains the external knowledge collection, decides per deployment whether ingress is switched on at all, and reviews any promotion of ingested knowledge into permanent guidance

## Behavior

### What May Be Ingested

**Scenario: Eligible knowledge is imported**
- Given the external knowledge collection holds entries of the kinds the platform recognizes as learning material — observed pitfalls, recurring patterns, and conventions
- When an ingestion cycle runs
- Then the eligible entries are brought in to inform future working sessions, each tagged with where in the collection it came from

**Scenario: Ineligible content is left behind**
- Given the external collection also holds material that is not recognized learning material
- When an ingestion cycle runs
- Then only the recognized kinds are brought in, and everything else is ignored

**Scenario: Ingestion is one-directional**
- Given the platform reads from the external collection
- When an ingestion cycle completes
- Then nothing the platform produced has been written back into the external collection — the collection is only ever read, never modified

### The Advisory-Only Firewall

**Scenario: Ingested knowledge informs a working session**
- Given knowledge has been ingested from the external collection
- When the platform prepares the working context for a piece of implementation work
- Then matching ingested knowledge may be included to inform that work, exactly as other learning material is

**Scenario: Ingested knowledge is barred from a risk judgment**
- Given knowledge has been ingested from the external collection
- When the platform classifies how risky a change is
- Then no ingested entry is allowed to inform that classification — the inputs to a risk judgment exclude anything of external-collection origin

**Scenario: Ingested knowledge is barred from a review verdict**
- Given knowledge has been ingested from the external collection
- When the platform decides whether a change passes a review or compliance check that can block it
- Then no ingested entry is allowed to inform that verdict — the inputs to such a check exclude anything of external-collection origin

**Scenario: Ingested knowledge is barred from an escalation decision**
- Given knowledge has been ingested from the external collection
- When the platform decides whether a matter must be escalated to the Operator
- Then no ingested entry can move a matter out of the set that must always be escalated, and the always-escalate set is unaffected by anything of external-collection origin

**Scenario: Ingested knowledge is barred from specification approval and release**
- Given knowledge has been ingested from the external collection
- When the platform prepares a specification-content approval or a release decision
- Then no ingested entry informs that decision — the inputs exclude anything of external-collection origin

**Scenario: Origin marking is the mechanism, not a label of intent**
- Given every record carries a marking of where it originated
- When the platform assembles the inputs for any risk judgment, blocking review or compliance verdict, escalation decision, specification-content approval, or release decision
- Then records marked as external-collection origin are withheld from that assembly by construction — the exclusion is enforced by the platform itself, not by relying on how any session chooses to use the knowledge

**Scenario: Unconfirmed origin is treated as external**
- Given a record whose origin cannot be confirmed as internally generated
- When the platform assembles the inputs for any decision the firewall protects
- Then that record is withheld as if it were of external-collection origin — the firewall fails toward exclusion, never toward admitting a record of doubtful origin

**Scenario: A leak through the firewall fails closed**
- Given the platform is assembling the inputs for a decision the firewall protects
- When a record of external-collection origin would reach that decision context
- Then the platform refuses to proceed rather than letting the record through — a detected leak is a hard stop, not a warning

### Ingress Is Switched Off Until the Firewall Is Enforced

**Scenario: Live ingress is paused until the firewall is a mechanism**
- Given the firewall is not yet enforced by construction across every protected decision
- When the platform would run an ingestion cycle that could carry external knowledge into a working session
- Then live ingress stays paused — it does not begin feeding sessions until the origin-based exclusion is proven to hold for every protected decision

**Scenario: A known open path keeps ingress paused**
- Given a review of the live paths finds that ingested knowledge can currently reach a blocking review or compliance check without being excluded by origin
- When deciding whether ingress may run
- Then ingress remains paused until that path is closed — an open path to any protected decision is sufficient on its own to keep ingress off

### Off By Default Per Deployment

**Scenario: A new deployment starts with ingress off**
- Given a deployment is set up
- When no one has switched ingress on for it
- Then ingress does not run for that deployment — external-knowledge ingress is off by default and is only ever active where the Operator has explicitly switched it on

**Scenario: Switching ingress off stops it without loss**
- Given ingress has been switched on for a deployment
- When the Operator switches it off
- Then no further ingestion cycles run, and knowledge already ingested keeps obeying the firewall for as long as it is retained

### Containment of Poisoned or Stale Entries

**Scenario: A re-ingested entry does not gain authority by repetition**
- Given the same entry is read from the external collection across many ingestion cycles
- When those cycles run
- Then the repeated readings do not accumulate into greater weight or standing for that entry — being read more often does not make an entry more trusted

**Scenario: A retired entry stops informing new sessions**
- Given an entry that was previously ingested is removed from the external collection, or is recognized as stale
- When the platform prepares context for new work after that point
- Then that entry is no longer drawn into new working sessions

**Scenario: A poisoned entry cannot reach a protected decision**
- Given an ingested entry contains a claim crafted to influence a risk judgment, a blocking review, an escalation, a specification approval, or a release
- When the platform makes any of those decisions
- Then the entry is excluded by its external-collection origin regardless of what it claims — the worst an ingested entry can do is mislead a working draft, which downstream verification can still catch, never weaken a gate or a classification

**Scenario: Ingested knowledge is held to the permanent-guidance approval boundary**
- Given ingested knowledge is being considered for promotion into permanent guidance
- When the platform proposes that promotion
- Then it remains a proposal until the Operator approves it — ingestion alone never turns external knowledge into permanent guidance

## Success Criteria

- Working sessions can be informed by the Operator's external knowledge collection without the Operator re-entering that knowledge by hand
- No ingested entry can be shown to have changed a risk classification, a blocking review or compliance verdict, an escalation decision, a specification-content approval, or a release outcome — the exclusion holds for every such decision and is enforced by the platform, not by session discipline
- A record of external-collection or unconfirmed origin that reaches a protected decision context causes a hard stop rather than a silently weakened decision
- Live ingress does not run while any path can carry ingested knowledge into a protected decision; it begins only once the origin-based exclusion provably holds everywhere
- A deployment that has not switched ingress on never ingests; ingress is active only where the Operator explicitly enabled it
- A poisoned, repeated, or stale external entry cannot gain standing, cannot reach a protected decision, and cannot become permanent guidance without Operator approval

## Constraints

- Ingested external knowledge is advisory-only: it may inform working drafts but may never inform or weaken a risk classification, a blocking review or compliance verdict, an escalation decision, a specification-content approval, or a release — this exclusion is a non-configurable mechanism enforced by construction, not a guideline about how sessions should use the knowledge
- The firewall rests on the origin of a record, not on a label of intent or trust: records of external-collection origin, and records whose origin cannot be confirmed as internally generated, are withheld from every protected decision; the firewall fails toward exclusion
- Live ingress stays off until the firewall is enforced and proven across every protected decision; an open path to even one protected decision keeps ingress paused
- External-knowledge ingress is off by default for every deployment and runs only where the Operator has explicitly switched it on
- No deployment setting, configuration, or learned behavior may switch the firewall off, narrow which decisions it protects, or relabel external-collection knowledge as anything other than external — configuration may only keep ingress more restricted, never grant ingested knowledge influence past the firewall
- The external collection is only ever read; the platform never writes back to it
- Repeated reading of the same external entry never increases its weight or standing, and a removed or stale entry stops informing new sessions
- Promoting ingested knowledge into permanent guidance always requires Operator approval, consistent with the permanent-knowledge approval boundary that governs all learning channels
- Adding this channel introduces no new Operator-reserved gate: the Operator's reserved decisions remain exactly specification-content approval and production release
