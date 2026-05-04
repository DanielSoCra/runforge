---
id: ARCH-AC-GOVERNANCE
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-SAFETY
---

# ARCH-AC-GOVERNANCE - Session Governance Context

## Overview

Session Governance Context gives every autonomous session the same highest-priority operating constraints before any role-specific instructions or repository-specific additions. The governance document is a versioned system artifact resolved by the Agent Service at startup and injected at session spawn. It consolidates absolute prohibitions, delivery constraints, and cost guardrails so safety rules are consistent across worker, reviewer, classifier, and coordination sessions.

## Data Model

**GovernanceDocument** is a versioned text artifact owned by the system. It contains three required sections: Absolute Prohibitions, Delivery Constraints, and Cost Guardrails. The document may contain named parameters for operator-configured values such as daily budget, per-run budget, and maximum delivery size.

**GovernanceParameterSet** is the resolved set of operator-configured values used to render a GovernanceDocument. It contains budget values, delivery size limits, and any future scalar values required by the governance text.

**ResolvedGovernanceContext** is the in-memory result of rendering the GovernanceDocument with the GovernanceParameterSet. It records the rendered content, source identifier, and parameter fingerprint. Intelligent sessions receive only the rendered content, never unresolved parameter names.

**GovernanceInjectionPolicy** defines ordering and preservation rules for session context assembly. Governance content has the highest priority, is prepended before all other context, and is never truncated by content-budget handling.

## API Contract

**Resolve governance context** - Called on Agent Service startup and reload. Request: GovernanceDocument source identifier and GovernanceParameterSet. Response: ResolvedGovernanceContext. Missing documents, empty documents, or unresolved parameters are invalid results.

**Assemble session context** - Called for every session spawn. Request: role-specific prompt, active repository additions, and the current ResolvedGovernanceContext. Response: a single ordered context where governance content appears before repository additions and role-specific prompt content.

**Reload governance context** - Called when operator configuration changes. Request: updated GovernanceDocument and GovernanceParameterSet. Effect: replace the active ResolvedGovernanceContext only if the new context resolves fully. On failure, retain the last-known-good context and surface an operator-visible warning.

## System Boundaries

- Agent Service OWNS: governance document resolution, parameter substitution, context ordering, preservation from truncation, and startup failure on invalid governance.
- File Storage OWNS: durable storage of the GovernanceDocument artifact.
- Operator OWNS: approving governance document changes and configuring scalar governance values.
- Intelligent sessions RECEIVE: rendered governance content as immutable input.
- Intelligent sessions NEVER OWN: governance document mutation, parameter resolution, or context ordering.

## Event Flows

**Startup resolution**
1. Agent Service loads the GovernanceDocument.
2. Agent Service builds the GovernanceParameterSet from operator configuration.
3. Agent Service renders the document and verifies no parameters remain unresolved.
4. If valid, the ResolvedGovernanceContext becomes active before any session can spawn.
5. If invalid, startup fails before autonomous work begins.

**Session spawn injection**
1. A caller requests an autonomous session.
2. Agent Service resolves role-specific prompt content and repository additions.
3. Agent Service prepends the active ResolvedGovernanceContext.
4. Agent Service applies content-budget rules to lower-priority additions only.
5. The provider receives governance content first, followed by repository additions, followed by role-specific prompt content.

**Configuration reload**
1. Operator changes governance parameters or document content.
2. Agent Service renders a candidate ResolvedGovernanceContext.
3. If valid, the candidate replaces the active context for future sessions.
4. If invalid, the previous context remains active and the Operator is notified.

## Error Handling

**Missing GovernanceDocument:** Agent Service refuses to start. A session without governance context is not allowed.

**Empty GovernanceDocument:** Agent Service refuses to start. Empty governance is equivalent to no governance.

**Unresolved parameter:** Agent Service refuses to start or rejects the reload candidate. Intelligent sessions must never receive literal unresolved parameter markers.

**Content budget exceeded:** Governance content is preserved. Lower-priority repository additions are reduced first.

**Budget exceeded during operation:** Agent Service pauses or parks work according to the safety policy instead of spending past configured limits.
