# decision-escalation test fixtures

## `pm-cockpit-decision-request.schema.json`

A **vendored, byte-identical copy** of pm-cockpit's committed
`packages/protocol/schema/decision-request.schema.json`.

It is the gate the pm-cockpit watcher's `parseDecisionBlock()` validates an
ingested decision-request block against (structural JSON Schema pre-check before
its zod gate). The cross-repo acceptance test in
`../github-block-notifier.test.ts` validates the block this daemon EMITS against
this exact schema with ajv — proving the cockpit will accept what we emit,
without a live cockpit and without a network call.

**Refresh it** (when pm-cockpit's protocol changes) by re-copying the source:

```sh
cp ../../../../../../../pm-cockpit/packages/protocol/schema/decision-request.schema.json \
   pm-cockpit-decision-request.schema.json
```

The acceptance test fails loudly (`cockpit schema rejected our block: …`) if our
emitted block ever drifts out of compatibility with this contract.
