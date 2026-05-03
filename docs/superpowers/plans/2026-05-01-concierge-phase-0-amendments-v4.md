# Concierge Phase 0 — Amendments v4 (CRITICAL: spec-id segment count)

Apply v1 plan ⊕ v1 amendments ⊕ v2 amendments ⊕ v3 amendments ⊕ this v4. Items not touched stand from prior layers.

## The find

Verifying daemon self-implementation empirically (Task 35), I checked the daemon's spec-ref extraction regex against the candidate spec IDs:

```javascript
const regex = /[A-Z]+-[A-Z]+-[A-Z0-9-]+/g;
'FUNC-CONCIERGE'.match(regex)         // → null  (FAIL — 2-segment ID)
'FUNC-OBSERVER'.match(regex)          // → null  (FAIL — 2-segment ID)
'FUNC-CONCIERGE-MEMORY'.match(regex)  // → ['FUNC-CONCIERGE-MEMORY']
'FUNC-OPERATOR-CHANNEL'.match(regex)  // → ['FUNC-OPERATOR-CHANNEL']
'FUNC-CONCIERGE-BOARD'.match(regex)   // → ['FUNC-CONCIERGE-BOARD']
```

Confirmed at `packages/daemon/src/control-plane/process-single.ts:94`:

```typescript
specRefs: (issueData.body ?? '').match(/[A-Z]+-[A-Z]+-[A-Z0-9-]+/g) ?? []
```

The regex requires a minimum of three hyphen-separated segments. The two L1 specs with 2-segment IDs would not be extracted from the issue body, so `specRefs` would be empty, so `loadSpecContent(specRefs, ...)` would return `''`, so the spec-implementation worker would receive **no** spec content. Daemon self-implementation blocked.

This is the highest-priority fix for the plan and was not caught by Codex iterations 1–3 because they reviewed against layer-contract semantics, not against the daemon's regex.

---

## Fix: rename two L1 specs to 3-segment IDs

| Old ID | New ID | Old filename | New filename |
|---|---|---|---|
| `FUNC-CONCIERGE` | **`FUNC-CONCIERGE-CORE`** | `concierge.md` | `concierge-core.md` |
| `FUNC-OBSERVER` | **`FUNC-CONCIERGE-AWARENESS`** | `observer.md` | `concierge-awareness.md` |

This also produces a uniform `FUNC-CONCIERGE-*` family for the concierge subsystem, with one outlier renamed for symmetry:

| Old ID (post-v1-amendment) | New ID (v4) |
|---|---|
| `FUNC-CONCIERGE-MEMORY` | unchanged |
| `FUNC-CONCIERGE-BOARD` | unchanged |
| `FUNC-OPERATOR-CHANNEL` | **`FUNC-CONCIERGE-CHANNEL`** *(rename for family consistency; not regex-driven)* |
| `FUNC-OBSERVER` → above | **`FUNC-CONCIERGE-AWARENESS`** |
| `FUNC-CONCIERGE` → above | **`FUNC-CONCIERGE-CORE`** |

Final L1 set: `FUNC-CONCIERGE-CORE`, `FUNC-CONCIERGE-MEMORY`, `FUNC-CONCIERGE-BOARD`, `FUNC-CONCIERGE-CHANNEL`, `FUNC-CONCIERGE-AWARENESS`. All five 3-segment, regex-safe, family-symmetric.

---

## Propagation checklist

The rename touches every prior amendment plus the v1 plan. Apply all of these during execution. Items prefixed ⚙ are mechanical search-and-replace.

### .specify/ files

⚙ The five new L1 spec files use renamed paths:
- `.specify/functional/concierge-core.md` (id `FUNC-CONCIERGE-CORE`)
- `.specify/functional/concierge-memory.md` (id `FUNC-CONCIERGE-MEMORY`)
- `.specify/functional/concierge-board.md` (id `FUNC-CONCIERGE-BOARD`)
- `.specify/functional/concierge-channel.md` (id `FUNC-CONCIERGE-CHANNEL`)
- `.specify/functional/concierge-awareness.md` (id `FUNC-CONCIERGE-AWARENESS`)

In each file's frontmatter `id:` field and main heading, use the new ID.

### .specify/traceability.yml

⚙ Replace the L0 children list:

```yaml
L0-CONCIERGE-VISION:
  children: [FUNC-CONCIERGE-CORE, FUNC-CONCIERGE-MEMORY, FUNC-CONCIERGE-BOARD,
             FUNC-CONCIERGE-CHANNEL, FUNC-CONCIERGE-AWARENESS]
  status: draft
```

⚙ Replace L1 entry keys (`FUNC-CONCIERGE` → `FUNC-CONCIERGE-CORE`, `FUNC-OBSERVER` → `FUNC-CONCIERGE-AWARENESS`, `FUNC-OPERATOR-CHANNEL` → `FUNC-CONCIERGE-CHANNEL`).

⚙ Replace ARCH parent fields that point at the renamed L1s:

```yaml
ARCH-CONCIERGE-RUNTIME:
  parent: FUNC-CONCIERGE-CORE   # was: FUNC-CONCIERGE
  children: [STACK-CONCIERGE-NODE, STACK-CONCIERGE-BOARD]

ARCH-TOOL-REGISTRY:
  parent: FUNC-CONCIERGE-CORE   # was: FUNC-CONCIERGE

ARCH-CONFIRMATION-LIFECYCLE:
  parent: FUNC-CONCIERGE-CORE   # was: FUNC-CONCIERGE

ARCH-EVENT-BUS:
  parent: FUNC-CONCIERGE-AWARENESS   # was: FUNC-OBSERVER
  children: [STACK-CONCIERGE-NODE]
```

### Task 15 test fixture (the fixture we already had to fix in v2 — fix again)

```typescript
it('all new concierge specs have entries', () => {
  const raw = readFileSync(resolve(ROOT, '.specify/traceability.yml'), 'utf-8');
  for (const id of [
    'FUNC-CONCIERGE-CORE', 'FUNC-CONCIERGE-MEMORY', 'FUNC-CONCIERGE-BOARD',
    'FUNC-CONCIERGE-CHANNEL', 'FUNC-CONCIERGE-AWARENESS',
    'ARCH-CONCIERGE-RUNTIME', 'ARCH-EVENT-BUS', 'ARCH-TOOL-REGISTRY',
    'ARCH-CONFIRMATION-LIFECYCLE',
    'STACK-CONCIERGE-NODE', 'STACK-CONCIERGE-BOARD',
  ]) {
    expect(raw, `expected ${id} in traceability`).toContain(`${id}:`);
  }
});
```

And the L0 children regex assertion:

```typescript
expect(raw).toMatch(/L0-CONCIERGE-VISION:[\s\S]*?children:\s*\[FUNC-CONCIERGE-CORE.*FUNC-CONCIERGE-AWARENESS\]/);
```

### Task 23 issue title and body

Replace title and body to use the renamed ID:

```bash
gh issue create \
  --title "Implement FUNC-CONCIERGE-CORE (concierge core agent)" \
  --body "$(cat <<'EOF'
Implements .specify/functional/concierge-core.md.

Spec ID: FUNC-CONCIERGE-CORE
L2 children (already drafted, l2-approved): ARCH-CONCIERGE-RUNTIME, ARCH-TOOL-REGISTRY, ARCH-CONFIRMATION-LIFECYCLE
L3 (already drafted, l3-approved): STACK-CONCIERGE-NODE
code_paths target: packages/concierge/

Daemon should skip l2-brainstorm and l3-generate (specs pre-authored,
labelled approved) and run the spec-implementation phase directly.

Reference: docs/superpowers/specs/2026-05-01-concierge-design.md
Phase 1 of the concierge rollout.
EOF
)" \
  --label "feature-pipeline,ready-to-implement,l1-approved,l2-approved,l3-approved" \
  --label "concierge,phase-1"
```

The four follow-up issues (Step 4 of v3-amended Task 23) likewise use the renamed IDs:
- `FUNC-CONCIERGE-MEMORY` (unchanged)
- `FUNC-CONCIERGE-CHANNEL` (was `FUNC-OPERATOR-CHANNEL`)
- `FUNC-CONCIERGE-AWARENESS` (was `FUNC-OBSERVER`)
- `FUNC-CONCIERGE-BOARD` (unchanged)

### Design doc consistency

The design doc at `docs/superpowers/specs/2026-05-01-concierge-design.md` references the old L1 names. Add a final commit during Phase 0 that updates the design doc's §5.2, §5.3, §6, and §7 tables so the names match what actually lands on disk. (Replace `FUNC-CONCIERGE` with `FUNC-CONCIERGE-CORE`; `FUNC-OBSERVER` with `FUNC-CONCIERGE-AWARENESS`; `FUNC-CHANNEL-SLACK`/`FUNC-OPERATOR-CHANNEL` with `FUNC-CONCIERGE-CHANNEL`.)

### Prompts and skills (Tasks 18, 19)

⚙ Search prompts under `prompts/` and skills under `plugins/auto-claude-dev/skills/` for the old IDs and replace with the new IDs.

---

## Verification before execution kicks off

Implementer's pre-flight checklist for Phase 0 execution:

```bash
# 1. Confirm regex would extract every concierge L1 from a representative issue body.
node -e "
const ids = ['FUNC-CONCIERGE-CORE','FUNC-CONCIERGE-MEMORY','FUNC-CONCIERGE-BOARD','FUNC-CONCIERGE-CHANNEL','FUNC-CONCIERGE-AWARENESS'];
const re = /[A-Z]+-[A-Z]+-[A-Z0-9-]+/g;
for (const id of ids) {
  const m = ('Spec ID: ' + id).match(re);
  if (!m || m[0] !== id) { console.error('FAIL:', id); process.exit(1); }
}
console.log('OK: all five concierge L1 IDs are regex-safe.');
"

# 2. Confirm traceability yields the full chain from FUNC-CONCIERGE-CORE.
pnpm --filter @auto-claude/daemon exec vitest run \
  src/infra/traceability-paths.test.ts -t "concierge spec tree"
```

Both must pass before opening the FUNC-CONCIERGE-CORE issue.

---

## Iteration audit (final)

| Iter | Verdict | Critical fixes |
|---|---|---|
| 1 | L1 contract violations + 5 structural | 5 L1 rewrites + Task 14/15/23 + first rename pass |
| 2 | 3 L1 nits + Task 14/15 incomplete + DoD conflict + L2/L3 deferred | 3 L1 fixes + Task 14/15 traceability completion + DoD reconciliation + Phase 0.5 schedule |
| 3 | 3 L1 nits + 4 consistency + Task 23 sequencing | 3 L1 single-line + 4 consistency notes + Task 23 sequencing fix |
| **4 (this)** | **Daemon spec-ref regex incompatibility (CRITICAL, daemon-empirical, missed by Codex)** | **Rename two L1s to 3-segment + family-symmetry rename of one more** |

After v4, the plan converges. The most consequential change in this iteration was **discovered by reading the daemon's actual code**, not by another Codex review pass. This is the kind of finding that argues for empirical verification of the daemon hand-off in addition to formal spec review. Adding to Phase 0 task list:

### Task 25 (NEW) — pre-execution regex verification

Before pushing the Phase 0 PR, run the regex verification snippet from this v4 amendment locally:

```bash
node -e "..."   # see Verification block above
pnpm --filter @auto-claude/daemon exec vitest run src/infra/traceability-paths.test.ts
```

Both green → proceed to PR. Either red → fix before pushing.

---

**Final daemon self-implementation verdict (v4):** YES, contingent on the renames in this amendment being applied. The FUNC-CONCIERGE-CORE issue (per amended Task 23) is regex-safe, label-correct, traceability-resolved, and will route to the daemon's spec-implementation phase on the next poll cycle after Phase 0 lands on `dev`.
