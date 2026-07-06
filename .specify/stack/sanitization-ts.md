---
id: STACK-AC-SANITIZATION
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: ts
references: ARCH-AC-SANITIZATION
code_paths:
  - packages/sanitization/src/types.ts
  - packages/sanitization/src/config.ts
  - packages/sanitization/src/pipeline.ts
  - packages/sanitization/src/registry.ts
  - packages/sanitization/src/index.ts
test_paths:
  - packages/sanitization/test/pipeline.test.ts
  - packages/sanitization/test/registry.test.ts
  - packages/sanitization/test/config.test.ts
---

# STACK-AC-SANITIZATION — @runforge/sanitization pipeline host

## Pattern

**Middleware chain (chain-of-responsibility) behind a port.** `@runforge/sanitization` is a standalone, domain-blind package: a `Sanitizer` port (`name` + `sanitize(input) → result`), a `SanitizationPipeline` that threads content through an ordered array of sanitizers (empty array = identity), and a `SanitizerRegistry` (name→factory) that `build()`s a pipeline from a deployment's `SanitizerBinding[]`. Chosen over baking sensitivity logic into the decision-index so recognition (secrets/PII/PHI) is a per-deployment plugin, not core (per ARCH-AC-SANITIZATION). No business meaning lives here.

## Key Decisions

- **zod for config** (the repo's schema lib): `SanitizerConfigSchema = z.array(SanitizerBindingSchema).default([])` — default empty = no sanitization. `SanitizerBindingSchema` is `.strict()` (reject unknown keys), `plugin` (non-empty) + opaque `options`.
- **Array position = activation order** (no separate `order` field) — simplest unambiguous ordering.
- **Errors propagate** from `run()` (a throwing sanitizer rejects the promise) so the caller fails closed; `build()` throws `UnknownSanitizerError` for an unregistered plugin (never a silent no-op that lets content through).
- **Pure + additive**: no I/O, no imports from other `@runforge/*` packages; wired nowhere in this slice.

## Examples

```ts
// empty pipeline is the identity
const r = await new SanitizationPipeline([]).run({ content }); // → { content, withholdings: [] }

// registry builds an ordered pipeline from deployment bindings
reg.register("secret-scrubber", (opts) => new SecretScrubber(opts));
const pipeline = reg.build(profile.sanitizers); // [] → identity
```

## Gotchas

- **Never mutate `input.content`** — copy (`{ ...content }`) before transforming; the caller's object must stay untouched (tested).
- **Empty must be an exact identity** — content deep-equal to input, `withholdings: []`; this is the default-deployment behavior, so any drift changes every default install.
- **`build([])` returns an empty pipeline, not null** — callers always get a runnable pipeline.
- **`withholdings` accumulate in application order** across sanitizers; don't dedupe or reorder.
