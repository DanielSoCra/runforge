---
id: STACK-AC-GOVERNANCE-DAEMON
type: stack-specific
domain: auto-claude
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-GOVERNANCE
code_paths:
  - FACTORY_RULES.md
  - packages/daemon/src/config.ts
  - packages/daemon/src/control-plane/daemon.ts
  - packages/daemon/src/control-plane/process-single.ts
  - packages/daemon/src/session-runtime/governance-context.ts
  - packages/daemon/src/session-runtime/plugin-injection.ts
  - packages/daemon/src/session-runtime/runtime.ts
test_paths:
  - packages/daemon/src/config.test.ts
  - packages/daemon/src/session-runtime/governance-context.test.ts
  - packages/daemon/src/session-runtime/plugin-injection.test.ts
  - packages/daemon/src/session-runtime/runtime.test.ts
---

# STACK-AC-GOVERNANCE-DAEMON - Governance Context Injection (TypeScript)

## Pattern

**Root markdown governance document.** `FACTORY_RULES.md` lives at the repository root. It is not a prompt template owned by the learning system; it is a versioned governance artifact loaded by the daemon before autonomous work starts.

**Strict parameter rendering.** `governance-context.ts` reads the document, substitutes scalar config values, and rejects missing, empty, or partially rendered output. The runtime uses rendered governance text only.

**CompositeContext first segment.** `plugin-injection.ts` carries governance as the first context segment. Token-budget shedding never drops governance; it only drops lower-priority plugin skills and agents.

## Key Decisions

**Cache after successful render.** The governance document is cached after successful startup validation so later branch movement in the daemon checkout cannot change governance text during a process lifetime.

**Parameterized values from existing daemon config.** Daily and per-run budget values come from existing budget fields. Delivery size uses the governance config section so operators can tune it without editing the document text.

**Runtime returns errors instead of spawning without governance.** If prompt assembly cannot load governance, `spawnSession` returns a failed `Result` before calling the provider adapter. Missing governance must not silently degrade to ordinary prompts.

## Examples

Render and reject unresolved tokens:

```typescript
const rendered = renderTemplate(raw, values);
if (findUnsubstitutedVars(rendered, {}).length > 0) throw new Error('unresolved governance parameter');
```

Prepend governance before plugins and prompt:

```typescript
const composite = buildCompositeContext(plugins, { governanceDocument: governance.content });
const prompt = [composite.governanceDocument, composite.promptInjection, rolePrompt]
  .filter(Boolean)
  .join('\n\n---\n\n');
```

## Gotchas

- Do not put `FACTORY_RULES.md` in `prompts/`; prompt proposals must not mutate governance.
- Keep unresolved parameter detection strict. A literal `{{dailyBudget}}` in a spawned session means the safety contract was not actually resolved.
- Preserve governance under token pressure even when it exceeds the nominal context budget. Failing closed is preferable to silently dropping the safety contract.
