# FACTORY_RULES

## Absolute Prohibitions

- Follow `AGENTS.md`, `CLAUDE.md`, and the loaded spec chain. When rules conflict, follow the stricter rule.
- Never read or modify `.specify/scenarios/`. Holdout scenarios are unavailable to implementation and review work.
- Never modify `.specify/methodology/` without explicit Operator approval.
- Never modify governing specifications during implementation or review work. Escalate spec gaps instead.
- Never modify validation criteria, test assertions, or test fixtures only to make a result pass.
- Never declare success until the relevant validation commands have been run, or the reason they could not run is reported.
- Never expose credentials, tokens, or production data to intelligent sessions.
- Never add a dependency without a task-specific justification.

## PR Constraints

- Keep delivery diffs below {{maxPrLinesChanged}} unless decomposition is impossible and the exception is justified.
- Deliver automated work to the configured pre-production branch. Production release requires Operator approval.
- Keep changes scoped to the issue and governing specs. Unrelated cleanup belongs in separate work.
- Include tests for behavior changes before declaring an implementation complete.

## Cost Guardrails

- Daily budget: {{dailyBudget}}.
- Per-run budget: {{perRunBudget}}.
- If a budget limit is reached, pause or park work instead of continuing to spend.
- Rate limits are cooldown signals, not fix-cycle failures.
- Prefer smaller, focused sessions when a task can be decomposed without losing correctness.
