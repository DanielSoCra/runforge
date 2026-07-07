---
id: STACK-AC-SANITIZER-REDACTION
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: ts
references: ARCH-AC-SANITIZATION
code_paths:
  - packages/sanitizer-redaction/src/protected-store.ts
  - packages/sanitizer-redaction/src/withholding-sanitizer.ts
  - packages/sanitizer-redaction/src/schema.ts
  - packages/sanitizer-redaction/src/index.ts
test_paths:
  - packages/sanitizer-redaction/test/protected-store.test.ts
  - packages/sanitizer-redaction/test/withholding-sanitizer.test.ts
---

# STACK-AC-SANITIZER-REDACTION — protected-store-backed withholding sanitizer

## Pattern

**A concrete `Sanitizer` plugin, not registered by default.** `@runforge/sanitizer-redaction` is the first real sanitizer for the `@runforge/sanitization` pipeline (STACK-AC-SANITIZATION): `createWithholdingSanitizer({ fields, marker?, store })` returns a `Sanitizer` that, for each configured field, encrypts the value into a `ProtectedStore` and replaces it with a `Withholding` (field + marker + `protected://` ref). The `ProtectedStore` (moved out of decision-index) owns AES-256-GCM-at-rest + HMAC integrity + the `protected_refs` table. This is the deployment-specific *policy* that the domain-blind core never carries — the regulated pilot deployment (deployment #1) registers it; generic runforge registers nothing.

## Key Decisions

- **Extracted from `decision-index`** so the core decision path is content-agnostic (no protected-store import). Wired NOWHERE by default — a deployment opts in via its profile's sanitizer bindings (Slice 4).
- **AES-256-GCM + HMAC, key bound to `(ulid, decision_id, field, class)` AAD** (carried over verbatim from the prior in-core implementation — sound, keep it). Key is a base64 32-byte AES-256 key.
- **Withheld value stored as `JSON.stringify(value)`** so any field shape round-trips through `get(ref)`.
- **Owns its `protected_refs` table** (drizzle) — the same table decision-index keeps (no migration); the plugin is the only writer now.

## Examples

```ts
const sanitizer = createWithholdingSanitizer({ fields: ["question", "context"], store });
const { content, withholdings } = await sanitizer.sanitize({ content: req });
// content drops the withheld fields; withholdings = [{ field, marker, ref: "protected://…" }]
store.get(withholdings[0].ref); // → original value (JSON)
```

## Gotchas

- **`content.decision_id` must be a string** — the sanitizer throws otherwise (the ref is bound to it). A throwing sanitizer fails the pipeline closed (per ARCH-AC-SANITIZATION).
- **Plaintext is never on disk unencrypted** — the blob is `MAGIC|iv|gcmTag|hmac|ciphertext`; a byte-scan of the store dir must not find the value (tested).
- **Not auto-registered** — adding this package as a dependency does nothing until a deployment profile names it in its sanitizer bindings.
- **`protected_refs` is shared with the legacy rows** decision-index still renders; do not change its shape without a migration.
