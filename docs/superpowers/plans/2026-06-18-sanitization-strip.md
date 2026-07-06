# Slice 3 — strip hardcoded classification, content-agnostic ingest (codex-decomposed)

**Branch:** `feat/sanitization-strip` (stacked on `feat/sanitization-pkg` → `feat/sanitization-specs`).
**Goal:** remove the inert acme-ported sensitivity classifier from the decision path; ingest becomes content-agnostic. Confidentiality becomes a config-driven sanitizer (ARCH-AC-SANITIZATION). NO pipeline injection yet — that's Slice 4.

## Decisions (codex planning, 2026-06-18)

1. **One atomic PR** for the protocol-breaking removal (green commits inside). Dropping `field_sensitivity` from `DecisionRequestSchema` + deleting `sensitivity.ts` ripples to ingest/index-writer/builders/tests — nothing compiles until all change together.
2. **`SensitivityClass` leaves `decision-protocol`.** `read-model.ts` keeps a tiny local `type ProtectedClass = string`, used ONLY to render legacy `protected://` rows. Do NOT import the sanitizer plugin into the read model (keeps the optional capability non-load-bearing).
3. **Extract `protected-store.ts` + redaction into a new, not-registered-by-default `@runforge/sanitizer-redaction` package.** Contains: encrypted redaction store, `protected://` ref helpers, `protected_refs` writer/reveal, a withholding Sanitizer (implements the `@runforge/sanitization` port), + its crypto/reveal tests. Core ingest never calls it by default.
4. **No destructive DB migration.** Keep `protected_refs`, `answer_ref`, and redactable text columns — safe no-ops; old persisted rows still render.
5. **Remove answer redaction** from `IndexWriter.applyEvent` (`answer_sensitivity → answer_ref`). Answers store plainly via `response_payload_json`; keep `answer_ref` column for legacy/plugin rows. Future answer sanitization goes through the configured pipeline, not `answer_sensitivity`.
6. **Scope split confirmed clean:** Slice 3 = content-agnostic ingest (remove redaction loop + `assertFullyClassified`), NO pipeline param. Slice 4 = inject/build `SanitizationPipeline`. Empty/default = identity per ARCH-AC-SANITIZATION.

## Ordered file changes

1. `decision-protocol`: delete `sensitivity.ts`; delete/repurpose `field-paths.ts`; remove `field_sensitivity`, `FieldSensitivitySchema`, `SensitivityClassSchema` + exports; regenerate `schema/decision-request.schema.json`.
2. `decision-index`: simplify `ingest.ts` (store parsed content as-is; drop `assertFullyClassified` + the `isProtected` redaction loop); remove `ProtectedStore` from `IngestDeps`; remove answer redaction from `index-writer.ts`; `read-model.ts` → local `ProtectedClass = string`; keep DB columns/tables; refresh `schema.ts` comments.
3. New `packages/sanitizer-redaction`: move `protected-store.ts` in; add the withholding Sanitizer + ref/reveal; remove `protected-store` from `decision-index/src/index.ts` exports.
4. `daemon` builders (`decision-escalation/build-request.ts`, `merge-decision/build-request.ts`): stop importing `SENSITIVITY_FIELD_PATHS`/`SensitivityClass`; drop `field_sensitivity`.
5. `github-block-notifier.ts`: schema-only validation; remove `assertFullyClassified`.
6. Update fixtures / golden JSON.

## Tests
- **Delete / move to plugin:** `sensitivity-redaction.test.ts`, `protected-store-binding.test.ts`, `sensitive-answer-validation.test.ts`, `sensitive-answer-hash.test.ts`, `sensitive-hash-no-sha-fallback.test.ts`.
- **Rewrite:** `protocol.test.ts`, daemon `build-request.test.ts` (×2), `github-block-notifier.test.ts`, `response-payload.test.ts`, `read-model-dashboard.test.ts`, `quarantine-content-free.test.ts`, `migrate.test.ts`, `index-writer-handle-leak.test.ts`, + any fixture/golden adding `field_sensitivity`.

## Gate (Claude authors) → Kimi implements → Codex reviews
Acceptance focus: (a) ingest stores content verbatim, no redaction, no classification gate; (b) a request WITHOUT `field_sensitivity` validates + ingests; (c) read-model still renders a legacy `protected://` row; (d) `@runforge/sanitizer-redaction` withholding Sanitizer round-trips via the protected store; (e) answers store plainly. Verify: full `pnpm -r test` + `tsc` + traceability test green.
