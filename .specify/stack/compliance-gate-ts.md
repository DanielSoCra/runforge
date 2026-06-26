---
id: STACK-AC-COMPLIANCE-GATE-TS
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-COMPLIANCE-GATE
code_paths:
  - packages/daemon/src/compliance/evaluator.ts
  - packages/daemon/src/compliance/schemas.ts
test_paths:
  - packages/daemon/src/compliance/evaluator.test.ts
  - packages/daemon/src/compliance/schemas.test.ts
---

# STACK-AC-COMPLIANCE-GATE-TS — Compliance Gate (TypeScript)

## Pattern

**Pure evaluator with fail-closed path matching and deterministic verdict aggregation.** The compliance gate is implemented as a set of pure functions in `packages/daemon/src/compliance/`. It receives a deployment profile's compliance section, the paths touched by a change, and recorded review verdicts, and returns a `ComplianceEvaluation`. There is no I/O inside the evaluator; callers pass everything in. This mirrors the lane-engine / steering decider pattern: edges pass data, the middle decides.

## Key Decisions

**`ComplianceProfileSchema` — minimal profile subset.** The schema contains only what the gate needs: an array of `RegulatedPath` entries, each with a glob pattern and the required reviewer role ids. The full deployment profile lives elsewhere; the gate reads this slice.

```typescript
const ComplianceProfileSchema = z.object({
  regulatedPaths: z.array(z.object({
    pattern: z.string().min(1),
    requiredReviewers: z.array(z.string().min(1)),
  })).default([]),
});
```

**`ComplianceReviewVerdictSchema` — flat verdict records.** Verdicts are passed as a map keyed by reviewer role id. Each verdict has a verdict enum and a reason.

```typescript
const ComplianceReviewVerdictSchema = z.object({
  reviewerRoleId: z.string(),
  verdict: z.enum(['pass', 'block']),
  reason: z.string().default(''),
  timestamp: z.string().datetime(),
});
```

**Path matching uses glob semantics via `micromatch`.** Regulated paths are glob patterns; touched paths are file paths relative to the repo root. If `micromatch` is unavailable, a simple `*` wildcard fallback is used. The match is deterministic and case-sensitive.

**Fail-closed verdict aggregation.** Required reviewers are the union across all matched regulated paths. A reviewer clears only if a `pass` verdict is present. Missing or `block` verdicts mean not cleared. The evaluation status is:
- `proceed` — no regulated paths touched, or all required reviewers passed.
- `blocked` — at least one required reviewer returned `block`.
- `hold` — no `block` verdicts, but at least one required review is missing or unfinished.

**`evaluateCompliance` is a total function.** It never throws on malformed input; invalid profiles are treated as having no regulated paths (proceed with a warning), and invalid touched paths or verdicts are ignored.

## Examples

```typescript
const profile = {
  regulatedPaths: [
    { pattern: 'packages/billing/**', requiredReviewers: ['billing-compliance'] },
    { pattern: 'packages/auth/**', requiredReviewers: ['security-compliance', 'privacy-compliance'] },
  ],
};

const evaluation = evaluateCompliance(
  profile,
  ['packages/billing/invoice.ts', 'packages/core/util.ts'],
  { 'billing-compliance': { reviewerRoleId: 'billing-compliance', verdict: 'pass', reason: '', timestamp: now } },
);
// evaluation.status === 'proceed'
```

## Gotchas

- The evaluator does not fetch verdicts from GitHub, Postgres, or any other store. Callers must load and pass the verdict map.
- A missing profile is treated as no requirements, not as a block. This keeps the gate opt-in per deployment.
- Required reviewers are a set union; if two paths require the same reviewer, that reviewer only needs to pass once.
- Path patterns are matched against the touched paths as provided. Normalize paths before calling if they may be absolute or contain `..` segments.
- The `blocked` status takes precedence over `hold`; if any required reviewer blocked, the change is blocked regardless of missing reviews.
