---
id: STACK-AC-AGENT-DISCIPLINE-REVIEW
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-AGENT-DISCIPLINE
code_paths:
  - prompts/reviewer-quality.md
  - packages/daemon/src/validation/review.ts
  - packages/daemon/src/validation/reviewer-session.ts
  - packages/daemon/src/validation/knowledge-injector.ts
test_paths:
  - packages/daemon/src/validation/review.test.ts
  - packages/daemon/src/validation/reviewer-session.test.ts
  - packages/daemon/src/validation/knowledge-injector.test.ts
---

# STACK-AC-AGENT-DISCIPLINE-REVIEW - Discipline Review (TypeScript)

## Pattern

**Discipline as a quality review dimension.** Add execution discipline to the existing quality reviewer rubric instead of creating a new review gate. It runs after specification compliance has passed and focuses on how the implementation behaved.

**Diff scope audit before model review.** Validation code extracts changed artifact paths from the diff and compares them to the ExecutionContract expected artifacts before spawning the reviewer. The result is injected as reviewer context.

**Structured discipline findings.** Reviewer output continues to use the existing findings shape, with descriptions identifying one of the discipline types: unresolved assumption, hidden ambiguity, speculative complexity, unrelated change, missing verification, or oversized change.

**Behavioral findings feed knowledge.** Confirmed discipline findings are passed to the existing knowledge injection flow as review findings, scoped to the affected artifacts.

## Key Decisions

**No separate gate number.** Discipline findings belong in quality review because they concern maintainability, scope control, and reviewability. Simple work that skips quality review does not need the extra review unless risk classification already requires it.

**Changed-file comparison is deterministic.** Use the diff metadata already available to Validation Service. The reviewer should receive the comparison result rather than spending reasoning capacity deriving it.

**Speculative complexity is blocking when untraceable.** Abstractions, configuration, broad error handling, and future-facing options are acceptable only when the current specification requires them.

**Do not flag pre-existing dead code.** The reviewer flags only changes introduced by the implementation or directly reintroduced by the fix cycle. Pre-existing unrelated defects can be mentioned outside blocking findings.

**Learning write-back is post-review.** Do not store every reviewer suspicion as knowledge. Store only confirmed findings after the review outcome is accepted by the pipeline.

## Examples

```typescript
const unexpectedFiles = changedFiles.filter(
  path => !matchesExpectedArtifact(path, contract.expectedArtifacts),
);
```

```typescript
const qualityRubric = {
  ...baseRubric,
  executionDiscipline: ['scope', 'simplicity', 'verification'],
};
```

```typescript
if (finding.type === 'unrelated-change') {
  return { approved: false, severity: 'important' };
}
```

## Gotchas

- Expected artifact patterns may include tests. A new regression test can be in scope even when the implementation file list did not name it explicitly.
- Diff size alone is not a failure. It becomes a finding when it materially exceeds the estimate and the added lines do not trace to success criteria.
- Quality review should not re-litigate specification compliance. If the behavior is required by spec, it is not speculative complexity.
- Known behavioral findings injected into reviewer context are guidance, not automatic failures. The reviewer still needs evidence in the current diff.
- If the execution contract is missing, fail review with a missing-verification or hidden-ambiguity style finding rather than letting the review pass silently.
