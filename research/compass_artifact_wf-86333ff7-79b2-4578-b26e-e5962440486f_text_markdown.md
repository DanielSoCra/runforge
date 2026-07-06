# Building an autonomous spec-driven dev daemon: four codebases dissected

**The four most instructive open-source projects for building an autonomous Claude Code orchestrator each solve a different piece of the puzzle.** Aperant provides the most complete reference architecture for a full spec-to-merge pipeline in TypeScript. OpenClaw demonstrates how to build a long-lived daemon with session routing and deterministic workflow orchestration. Karpathy's autoresearch proves that Markdown-as-spec with git-as-state is a viable — even superior — pattern for autonomous agent loops. And Superpowers delivers the most battle-tested prompt engineering for subagent dispatch, context isolation, and quality gates. Together, they form a nearly complete blueprint for the system you're building.

This report extracts the concrete architectural decisions, code patterns, and hard-won lessons from each project, organized around the exact capabilities your daemon needs.

---

## How each project spawns and manages Claude Code sessions

The four projects take fundamentally different approaches to LLM session management, and your daemon can learn from each.

**Aperant** runs a two-layer architecture. Its primary TypeScript AI layer uses **Vercel AI SDK v6** with `streamText()` and `generateText()` calls, routing through a provider registry that supports 9+ LLM providers (Anthropic, OpenAI, Google, Bedrock, etc.). Agent sessions run in **Node.js `worker_threads`** to avoid blocking the Electron main process — a pattern directly applicable to your daemon. The `WorkerBridge` class relays `postMessage()` events to an `AgentManagerEvents` interface, giving the coordinator clean lifecycle hooks. A Python sidecar still handles spec creation via the `claude-agent-sdk` package, which wraps the Claude CLI binary (found via `CLAUDE_CLI_PATH` env var or `find_claude_cli()` auto-detection). The spawn chain is `Electron → Python subprocess → Claude SDK → CLI binary`, and this fragility is a documented pain point — exit code 127 ("command not found") is a recurring issue, especially on macOS packaged apps.

**OpenClaw** takes the single-process gateway approach. When you run `openclaw gateway`, a single long-lived Node.js process owns everything: channel adapters, session management, queue, agent runtime, and control plane. It does **not** use Claude Code CLI at all — instead making direct API calls via OpenAI-compatible endpoints. Sessions are persisted as **JSONL transcript files** with composite session keys encoding `agent:<agentId>:<scope>`. Sub-agent spawning uses `sessions_spawn` (depth limit: 2, global concurrency ceiling: 8) and `agentToAgent` for peer messaging. For your daemon, the key insight is OpenClaw's **session-key routing pattern**: composite keys that deterministically route to the correct agent + project + role combination.

**Karpathy's autoresearch** takes the radical opposite approach: it contains **zero LLM orchestration code**. The repo is an *environment* that an external coding agent operates in. The human launches Claude Code CLI pointed at the repo directory, says "read program.md and start," and the agent enters an autonomous loop. The orchestration lives entirely in the `program.md` Markdown file — natural language instructions that Claude follows procedurally. This "Markdown-as-orchestration" pattern is surprisingly robust and eliminates an entire category of subprocess management bugs.

**Superpowers** also avoids managing sessions directly. It uses Claude Code's **SessionStart hook** mechanism to inject behavioral rules before the agent's first response. A `hooks.json` file registers a `session-start.sh` script that reads skill Markdown files, escapes them for JSON, and injects them as `<EXTREMELY_IMPORTANT>` context. The critical detail: **`async: false`** was required (changed in v4.3.0) because async hooks caused race conditions where the bootstrap didn't complete before the agent's first turn.

For your daemon, the strongest pattern is **Aperant's worker thread model combined with direct API calls**. Use `worker_threads` to isolate each Claude session, communicate via `postMessage()`, and call the Anthropic API directly through `@ai-sdk/anthropic` rather than shelling out to the CLI binary. This eliminates the CLI detection fragility that plagues Aperant's Python sidecar. If you must use Claude Code CLI (for tool use, MCP, etc.), wrap it in a subprocess with explicit `CLAUDE_CLI_PATH` and handle exit code 127 gracefully.

---

## Task decomposition patterns that actually work at scale

The projects reveal two distinct philosophies for breaking work into parallel units: **AI-driven decomposition** (let the LLM plan) and **structural decomposition** (the system enforces the granularity).

**Aperant's pipeline** is the most complete reference. Specs go through six phases: project discovery → requirements gathering → complexity assessment → historical context → spec writing → planning. The planner agent reads the spec and produces an `implementation_plan.json` with subtasks. Each subtask gets "a clear, self-contained assignment with all the context it needs: relevant file paths, the specific change to make, and acceptance criteria." Parallel execution uses **`Promise.allSettled()`** — critical because it handles partial failures gracefully (some agents can fail without blocking the entire pipeline). The coder agent can spawn parallel subagents, and a "parallel AI merge" feature handles integration of completed builds.

**Superpowers' subagent-driven development** is the most prescriptive about *how* to decompose. Plans are written to `docs/plans/YYYY-MM-DD-<feature-name>.md` with each task scoped to **2-5 minutes of work**, including exact file paths, complete code snippets, and verification steps. The controller (parent agent) reads the plan once, extracts all tasks with full text, creates TodoWrite entries, then dispatches a **fresh implementer subagent per task** with only that task's context (~1-2k tokens vs. the full 48k plan). This context isolation is the key innovation — it prevents context window pollution and keeps each subagent focused. Token efficiency: ~15k (one plan read) + ~2k per dispatch = ~33k total vs. monolithic ~60k+.

**Karpathy's approach** has no decomposition at all — it's **single-lineage hill-climbing** where each iteration is atomic (modify → train → evaluate → keep/discard). But the constraint is instructive: by keeping the entire mutable codebase to ~630 lines (fits in one context window), the agent can understand everything holistically. For your daemon, this suggests a useful heuristic: **if a subtask's context doesn't fit in one context window, decompose further**.

For your daemon's decomposition strategy, combine Aperant's planner phase with Superpowers' subagent dispatch pattern:

1. Use a planner agent to read the spec and produce a structured JSON plan (Aperant's `implementation_plan.json` pattern)
2. Each subtask in the plan should include full context, file paths, acceptance criteria, and be scoped to fit in a single context window (Superpowers' 2-5 minute rule)
3. Dispatch each subtask to a fresh worker thread with only that task's context pasted into the prompt — never reference files by path (Superpowers' context isolation)
4. Use `Promise.allSettled()` for parallel execution with graceful partial failure (Aperant)
5. Track subtask status with a four-state protocol: **DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT** (Superpowers)

---

## Git worktrees as the universal isolation mechanism

Every project either uses or references git worktrees as the primary mechanism for safe parallel work. This is the strongest consensus across all four codebases.

**Aperant** makes worktrees its core isolation mechanism. All work happens in isolated git worktrees so the main branch stays safe. Worktree metadata is stored in `.runforge/worktrees/`. It implements branch namespace conflict detection to prevent creation failures, supports detached HEAD state during PR creation, includes parallel merge conflict resolution with progress tracking, and targets the `develop` branch (never `main`, which is reserved for releases). A known gotcha: worktree creation can fail silently if branch names collide.

**Superpowers** enforces worktree usage through its `using-git-worktrees` skill. It checks a priority order for worktree location: `.worktrees/` → `worktrees/` → CLAUDE.md preference → ask user. Before creating a worktree, it verifies the directory is git-ignored. After work completes, the `finishing-a-development-branch` skill offers four options: merge to source branch, create PR via `gh`, keep worktree, or discard.

**Karpathy's approach** uses **branches as the ratcheting mechanism** — only improvements survive in the branch history, failures are `git reset` to the last good state. The branch naming convention `autoresearch/<tag>` (or `exp/{GPU}/{tag}` for collaborative sessions) provides clean namespacing.

For your daemon, implement worktrees as follows:

```typescript
// Worktree creation pattern (synthesized from Aperant + Superpowers)
async function createWorktree(issueId: string, spec: Spec): Promise<Worktree> {
  const branch = `factory/${issueId}-${slugify(spec.title)}`;
  // Check for namespace conflicts (Aperant gotcha)
  if (await branchExists(branch)) throw new ConflictError(branch);
  // Create worktree in gitignored directory (Superpowers pattern)
  await exec(`git worktree add .worktrees/${branch} -b ${branch}`);
  // Run project setup in worktree (Superpowers requirement)
  await exec(`cd .worktrees/${branch} && npm install`);
  // Verify clean test baseline (Superpowers pattern)
  await exec(`cd .worktrees/${branch} && npm test`);
  return { path: `.worktrees/${branch}`, branch, issueId };
}
```

Always target a `develop` or `staging` branch, never `main`. Use `git worktree remove` for cleanup after merge or discard.

---

## State management across crash boundaries

Each project reveals different trade-offs in how to persist state so that work survives crashes, restarts, and long-running overnight builds.

**Aperant** uses a **project-directory approach**: the `.runforge/` directory contains the entire persistent state — specs, plans, QA reports, worktree metadata, and memory databases. Each spec lives in `.runforge/specs/XXX-name/` with structured JSON files (`requirements.json`, `complexity_assessment.json`, `implementation_plan.json`) alongside Markdown artifacts (`spec.md`, `qa_report.md`). The critical lesson: **this directory must never be deleted** — Aperant documents that external tools (including Claude Code itself) have accidentally destroyed it. They also switched to **atomic writes** after discovering 0-byte file corruption in plan files during crashes.

**OpenClaw** takes a **file-as-state** philosophy where everything is Markdown/JSON on disk. Sessions are JSONL transcript files, memory is `MEMORY.md`, configuration is `openclaw.json`, and cost tracking uses SQLite. No external database required — the filesystem IS the state store. This is inspectable, versionable, and grep-able.

**Karpathy** uses the **most minimal state management**: git branches (the canonical state), `results.tsv` (the experiment log), and `run.log` (ephemeral per-run output). Git provides versioning, rollback, and audit trail. The TSV file provides queryable history. This is remarkably robust for single-lineage workflows.

For your daemon, combine these patterns into a three-tier state system:

- **Tier 1 — Git** (canonical): The worktree branch IS the implementation state. Commits represent checkpoints. `git reset` provides rollback.
- **Tier 2 — Structured JSON on disk** (operational): A `.factory/` directory per-project with `pipeline-state.json` tracking issue status, subtask progress, review results. Use atomic writes (write to temp file, then rename) to prevent corruption.
- **Tier 3 — SQLite** (queryable): Token usage, timing metrics, error history. Survives process restarts and supports queries for dashboards.

The key rule from Aperant: **never let agents access the state directory with write tools**. Isolate it from the agent's working directory.

---

## Error handling strategies that survive overnight builds

Aperant's error handling is the most battle-tested, born from users running long overnight builds that encounter every failure mode.

**Aperant classifies errors into categories with distinct strategies**: HTTP 429 (rate limit) → switch to another Claude profile automatically via `profile-scorer.ts`; HTTP 401 (auth) → refresh OAuth token via `token-refresh.ts`; HTTP 400 (bad request) → adjust input; exit code 127 (CLI not found) → clear cache and re-detect. The **multi-account swapping** pattern is particularly valuable: when one Claude account hits rate limits, it scores all profiles by usage and availability, then switches. Each spec creation phase retries up to **MAX_RETRIES = 3**, with error messages tracking consecutive failures. They also implemented **OOM and orphaned agent prevention** for overnight builds after discovering unbounded growth.

**OpenClaw** implements **model failover with exponential backoff** — multiple providers configured in a fallback chain, with automatic provider switching when one goes down. Messages arriving mid-run are queued and injected into the next turn or collected for follow-up.

**Karpathy's error handling is entirely LLM-driven**: if `grep "^val_bpb:" run.log` returns empty, the run crashed. The agent runs `tail -n 50 run.log` to read the stack trace and decides whether to fix (trivial error) or abandon (fundamental failure). A 10-minute hard timeout kills hung processes. This works because the agent's judgment is the retry policy.

For your daemon, implement a **tiered error handler**:

```typescript
// Error classification pattern (from Aperant)
function classifyError(error: AgentError): ErrorStrategy {
  if (error.status === 429) return { action: 'SWITCH_PROFILE', delay: 0 };
  if (error.status === 401) return { action: 'REFRESH_TOKEN', delay: 0 };
  if (error.status === 400) return { action: 'RETRY_WITH_MODIFIED_INPUT', delay: 1000 };
  if (error.exitCode === 127) return { action: 'REDETECT_CLI', delay: 0 };
  if (error.type === 'OOM') return { action: 'KILL_AND_REVERT', delay: 0 };
  if (error.type === 'TIMEOUT') return { action: 'KILL_AND_LOG', delay: 0 };
  return { action: 'RETRY', delay: exponentialBackoff(error.attempt), maxRetries: 3 };
}
```

The most important lesson from Aperant: **orphaned agent detection**. Your daemon must track all spawned worker threads and kill zombies on shutdown or restart. Without this, overnight runs will OOM.

---

## Review gates that catch failures before merge

The review patterns across these projects reveal a clear best practice: **never trust the implementer's self-report**.

**Superpowers** makes this explicit with its `spec-reviewer-prompt.md`:

> "The implementer finished suspiciously quickly. Their report may be incomplete, inaccurate, or optimistic. You MUST verify everything independently."

Superpowers enforces a **two-stage review**: first a spec compliance reviewer (did they build what was requested?), then a code quality reviewer (is it well-written?). This separation prevents conflation — an agent might rate code quality highly while missing that it doesn't match the spec. Each reviewer is a **fresh subagent** with no accumulated context from the implementation phase, preventing confirmation bias.

**Aperant** runs a QA reviewer agent that validates the implementation against the spec, followed by a QA fixer agent that resolves discovered issues. It also features AI-powered PR review with evidence-based validation, context enrichment, and cross-validation. The PR review pipeline uses structured output validation with three-tier recovery to handle cases where the review agent produces malformed output.

For your daemon's pipeline, implement three quality gates:

1. **Holdout validation** (automated): Run tests that the implementing agent never saw. This is your "fixed evaluator" (Karpathy's prepare.py pattern) — tests the agent cannot game because they were withheld during implementation.
2. **Spec compliance review** (fresh agent): A clean subagent verifies every acceptance criterion in the spec is met, with independent file reading — never trusting the implementer's report.
3. **Code quality review** (fresh agent): Separate subagent reviews for maintainability, test quality, and architectural consistency.

Only after all three gates pass does the PR get created. This is the synthesis of Superpowers' two-stage review + Karpathy's fixed evaluator pattern.

---

## Configuration and the coordinator/worker boundary

The projects reveal a critical architectural insight about where intelligence should live versus where determinism should live — exactly the coordinator/worker split your daemon needs.

**OpenClaw's Lobster workflow engine** is the clearest example of this split. Deterministic sequencing, data flow, approval gates, and retry logic live in YAML workflow definitions. LLMs only handle the creative work within each step. This means the pipeline never gets confused about what step it's on, never skips a gate, and never needs to be "reminded" of the process. The same principle appears in **OpenClaw's Caclawphony** system, which polls Linear every 30 seconds for issues in specific states and dispatches coding agents per pipeline state — the polling and state machine are deterministic Elixir code; only the actual coding is LLM-driven.

**Aperant's configuration** uses phase-aware model resolution — cheaper models (Haiku) for simple phases like discovery, expensive models (Opus) for complex coding. The 25+ agent types in `AGENT_CONFIGS` each specify thinking budgets and model preferences per phase. This is directly applicable: your daemon should use Sonnet for planning and review, Opus only for complex implementation subtasks.

**Superpowers** achieves configuration through a three-tier skill priority system: project skills (`.superpowers/skills/`) override personal skills (`~/.claude/skills/`) which override default skills. User instructions in CLAUDE.md always take precedence. This layered override pattern is clean and predictable.

For your daemon, the coordinator/worker boundary should be:

| **TypeScript coordinator (deterministic)** | **Claude workers (intelligent)** |
|---|---|
| Poll GitHub Issues for `factory-ready` label | Decompose specs into subtasks |
| Create/manage git worktrees | Write implementation code |
| Spawn/kill worker threads | Review code for spec compliance |
| Route subtasks to workers | Assess complexity and risk |
| Enforce pipeline state machine | Generate PR descriptions |
| Run tests, check exit codes | Debug test failures |
| Create PRs via `gh` CLI | Decide what to try next |
| Deploy to dev environment | — |
| Track metrics in SQLite | — |

The TypeScript coordinator should be a **finite state machine** where each issue transitions through: `QUEUED → DECOMPOSING → IMPLEMENTING → REVIEWING → VALIDATING → PR_CREATED → DEPLOYING → TESTING → CLOSING → RELEASED`. State transitions are deterministic; the work within each state is LLM-driven.

---

## What to reuse directly and what to build fresh

**Directly reusable patterns and code:**

Aperant's `Promise.allSettled()` pattern for parallel subagent execution is production-ready. Its error classification system (429/401/400/127 routing) is comprehensive. Its atomic write pattern for state files prevents corruption. The provider factory pattern using Vercel AI SDK v6's `createProviderRegistry()` gives you multi-provider support for free.

Superpowers' subagent prompt templates (`implementer-prompt.md`, `spec-reviewer-prompt.md`, `code-quality-reviewer-prompt.md`) are directly usable as your worker prompts. The four-status protocol (DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT) is a clean contract between coordinator and worker. The context isolation principle — paste full task context, never reference files by path — is essential.

Karpathy's "output redirection + grep" pattern (`> run.log 2>&1` then `grep` for metrics) prevents context window flooding during test runs. His git-as-ratchet pattern (only improvements survive, failures get `git reset`) is ideal for your implementation phase. The `results.tsv` experiment log pattern maps directly to a pipeline metrics table.

OpenClaw's session-key routing (`agent:<agentId>:<scope>`) and its Lobster-style deterministic workflow YAML are both adaptable to your pipeline definition.

**What you must build fresh:**

The GitHub Issue polling loop (none of these projects poll GitHub). The `factory-ready` label detection and issue parsing. The holdout validation system (withholding test cases from the implementing agent). The deploy-to-dev pipeline integration. The release automation after issue closure. The bug vs. feature routing logic (different pipeline shapes for each). And the daemon lifecycle management (systemd/launchd integration, health checks, graceful shutdown with orphaned agent cleanup).

---

## Conclusion: the synthesized architecture

The optimal architecture for your daemon emerges from combining the strongest patterns across all four projects. Use **Aperant's worker thread isolation** with **Vercel AI SDK v6** for session management — this eliminates CLI detection fragility while keeping sessions non-blocking. Adopt **OpenClaw's long-lived daemon pattern** with a deterministic state machine (not LLM-driven) controlling pipeline flow. Apply **Karpathy's Markdown-as-spec** philosophy for your issue specs and **git-as-ratchet** for implementation state. And implement **Superpowers' subagent dispatch pattern** — fresh agent per task, context isolation, two-stage review — for all LLM-driven work.

The most counterintuitive lesson across all four projects: **less orchestration code is better**. Karpathy achieved autonomous research with 3 files and a Markdown spec. Superpowers orchestrates complex multi-agent development with zero traditional application code. The sophistication should live in the prompts and the pipeline state machine, not in elaborate agent management frameworks. Your TypeScript daemon should be a thin, rigid state machine that spawns Claude sessions with excellent prompts — and the prompts, not the code, should encode the intelligence.