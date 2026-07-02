---
id: {STACK_PREFIX}-{DOMAIN-KEY}
type: stack-specific
domain: {domain}
status: draft
version: 1
layer: 3
stack: {stack}
references: ARCH-{PARENT-ID}
# While status is draft (spec authored ahead of code), code_paths/test_paths
# MUST be glob patterns (e.g. `packages/{pkg}/src/{feature}/**`), not literal
# file paths — infra/traceability-paths.test.ts fails the build if a literal
# path doesn't exist on disk yet. Narrow to exact file paths only once the
# implementation lands and status flips to something other than draft.
code_paths:
  - {path/to/feature/dir}/**
test_paths:
  - {path/to/feature/dir}/**/*.test.ts
---

# {STACK_PREFIX}-{DOMAIN-KEY} — {Title}

## Pattern

<!-- What named pattern does this use? Why was it chosen over alternatives? -->
<!-- Example: "State machine pattern for lifecycle management. Chosen over simple enum because transitions have side effects and guard conditions." -->

## Key Decisions

<!-- Library choices with rationale. Trade-offs considered. -->
<!-- Example: "Using Solid Queue over Sidekiq — simpler deployment (no Redis), sufficient for our throughput." -->

## Examples

<!-- 3-5 line code snippets showing the KEY pattern. Not complete implementations. -->
<!-- The builder writes the full code guided by these patterns. -->

## Gotchas

<!-- Things to watch out for during implementation. Common mistakes. Edge cases. -->
