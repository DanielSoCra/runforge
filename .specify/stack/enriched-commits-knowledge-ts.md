---
id: STACK-AC-ENRICHED-COMMITS-KNOWLEDGE
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-ENRICHED-COMMITS
code_paths:
  - src/knowledge/parse-commits.ts
  - src/control-plane/completion.ts
test_paths:
  - src/knowledge/parse-commits.test.ts
  - src/control-plane/completion.test.ts
---

# STACK-AC-ENRICHED-COMMITS-KNOWLEDGE — Enriched Commits: Knowledge Service & Control Plane (TypeScript)

## Pattern

**Regex field extraction** from structured commit message bodies in a standalone parse module. Each commit is parsed independently. Extracted entries create or update Gotchas via the existing `storeGotcha` path. The Control Plane reads the commit log at run completion using a separator-delimited git format.

## Key Decisions

**Standalone module** (`src/knowledge/parse-commits.ts`) rather than inlined in the Knowledge Service class. The parser takes string input and returns Gotcha data — no service dependencies. This makes it independently testable without mocking the Knowledge Service.

**Separator-delimited git log format** (`--format=%B---COMMIT---`) rather than structured git format. Simpler to split and more reliable than line-by-line parsing when commit bodies contain newlines.

## Examples

```typescript
// src/knowledge/parse-commits.ts — field extraction
const ARTIFACTS_RE = /^Artifacts:\s*(.+)$/m;
const DISCOVERED_RE = /^Discovered:\s*(.+)$/m;
const DEAD_ENDS_RE = /^Dead-ends:\s*(.+)$/m;
```

```typescript
// src/knowledge/parse-commits.ts — one ParsedGotcha per recognized field line
type ParsedGotcha = {
  artifacts: string[]; description: string;
  kind: 'discovered' | 'dead-end'; originType: 'autonomous';
};
// parseCommits(messages: string[], workRequestId: string): ParsedGotcha[]
```

```typescript
// src/control-plane/completion.ts — reading commit log
const log = await git(['log', '--format=%B---COMMIT---', `${baseBranch}..${featureBranch}`]);
const messages = log.split('---COMMIT---').filter(s => s.trim().length > 0);
```

## Gotchas

- `git log A..B` returns empty output when A and B are the same commit (no new commits). Check for an empty `messages` array before calling `parseCommits` — this is expected after simple fast-forward merges, not an error.
- Merge commit bodies typically lack the structured fields and will be skipped silently — correct behavior, not a bug.
- Split `Artifacts:` on `,` then trim each segment: `value.split(',').map(s => s.trim()).filter(Boolean)`. This handles trailing commas and extra whitespace from worker output without producing empty artifact patterns.
- `parseCommits` failure must not affect run completion or operator notification. Wrap the call in a try/catch at the Control Plane callsite and log the error without re-throwing.
- The `---COMMIT---` separator is not escaped in git output — a commit body containing that exact string will split into spurious extra entries. Mitigate by filtering: skip any split segment that contains none of the recognized field prefixes (`Discovered:`, `Dead-ends:`, `Artifacts:`) before passing to the parser.
