---
id: STACK-AC-SESSION-RUNTIME
type: stack-specific
domain: runforge
status: draft
version: 1
layer: 3
stack: typescript
references: ARCH-AC-SESSION-RUNTIME
code_paths:
  - packages/daemon/src/session-runtime/
test_paths:
  - packages/daemon/src/session-runtime/**/*.test.ts
---

# STACK-AC-SESSION-RUNTIME — Session Runtime (TypeScript)

## Pattern

**Adapter pattern for execution substrate.** Two concrete adapters behind a common interface. The runtime selects one at startup based on config and never switches mid-run. Callers see only `spawnSession(type, context, workspace?)` and receive a `SessionResult`.

**Pool pattern for workspaces.** Pre-provisioned Docker containers on a Hetzner dedicated server. The pool maintains a warm supply. Allocation is instant (grab from pool); provisioning runs in background to replenish.

**Middleware chain for containment.** Each containment layer is an independent middleware that can block or pass. Layers compose: workspace exclusion → path blocking → content inspection → read/write classification → behavioral constraints. Post-session audit runs after completion.

## Key Decisions

**SDK Adapter: `@anthropic-ai/claude-agent-sdk`.** TypeScript library for programmatic session execution. Sessions are `query()` calls returning async message streams. Hooks are TypeScript callbacks passed directly. Structured output via `outputSchema`. Cost extracted from response headers (`x-usage`). Requires `ANTHROPIC_API_KEY`.

**CLI Adapter: `claude` CLI in headless mode.** Spawn via `claude -p "prompt" --output-format json --max-turns N --allowedTools [tools]`. For structured output: `--json-schema '{...}'`. For subagents: `--agents '{...}'`. For session resume: `--resume sessionId`. Parse JSON from stdout. Cost extracted from JSON metadata field. Works with Claude Max subscription (no API key needed).

**Workspace Pool: Docker containers on Hetzner.** Each container is a fresh clone with dependencies pre-installed and build caches warm. Managed via Docker Engine API over SSH tunnel to the Hetzner server. Containers are single-use — destroyed after session completion, never reused.

**Containment hooks: Read-only shell scripts mounted from outside the workspace.** PreToolUse hooks intercept tool calls before execution. The hook script receives the tool name and input as JSON on stdin, exits 0 to allow or non-zero to block (with reason on stderr). Hooks are stored in the daemon's own directory (not inside the workspace) and mounted read-only into Docker containers. The SDK Adapter uses TypeScript callback hooks in a standalone module (`src/session-runtime/containment-hooks.ts`) with the same logic — loaded once at startup, frozen interface, tested independently.

**Secrets: Environment variables with explicit isolation.** Loaded from a `.env.production` file on startup (never committed). The `SecretsSnapshot` is a `Map<string, string>` held in memory. Reload on SIGHUP: re-read `.env.production`, validate all required keys present, atomic swap. When spawning sessions, NEVER pass `process.env` — construct an explicit allowlist (`PATH`, `HOME`, `TERM`, and session-specific variables only). Secrets never reach intelligent sessions.

**Docker security: Container hardening.** Every workspace container runs with: `--network none` (or a restricted network allowing only the daemon host), `--read-only` for system paths, `--memory` and `--cpus` limits, `--security-opt no-new-privileges`, non-root user. No production data, no production network routes. Hook files mounted read-only. SSH tunnel to Hetzner uses a persistent control socket (`ControlMaster`) with health checks and reconnection on failure.

**Concurrency: Worker pool with stagger.** Sessions run as async operations (SDK) or child processes (CLI) in the main Node.js event loop. No `worker_threads` needed — the execution substrate (API call or CLI process) is already external. Stagger delay between session starts prevents thundering herd on rate limits.

**Context compaction: Summarize-and-continue.** During long agentic sessions, monitor token usage from response metadata. When usage exceeds a configurable threshold (e.g., 80% of model context), trigger compaction: spawn a separate low-cost session to summarize the conversation history, then inject the summary as a continuation prompt. The SDK Adapter reads token counts from response headers; the CLI Adapter parses them from JSON metadata.

**Within-session repetition detection: Call history tracking.** Maintain a sliding window of recent tool calls (tool name + argument hash) per session. When the same call appears more than a configurable number of times consecutively (default: 5), block the call and inject an intervention message. For the SDK Adapter, this is a hook callback that checks before each tool execution. For the CLI Adapter, this is tracked by parsing the session's stdout stream for tool call events.

**Large response offloading: File-based replacement.** After each tool call, check the response size. If it exceeds a configurable threshold (default: 200,000 characters), write the content to a temporary file inside the workspace and replace the response with a short message: `"Response too large (N chars). Content saved to: /path/to/file. Read specific sections as needed."` The SDK Adapter intercepts tool results in the message stream; the CLI Adapter uses a PostToolUse hook.

**Prompt assembly: Session Runtime renders, Knowledge Service owns.** Prompt templates live in `prompts/` (owned by Knowledge Service). Session Runtime loads the template, injects context variables via `renderPrompt()`, and appends containment prohibitions. The final assembled prompt is what the adapter receives. Templates use simple `{{variable}}` placeholders (see STACK-AC-KNOWLEDGE).

## Examples

```typescript
// Provider adapter interface
interface ProviderAdapter {
  spawn(def: AgentDefinition, ctx: SessionContext): Promise<SessionResult>;
  estimateCost(result: SessionResult): CurrencyAmount;
}
```

```typescript
// CLI adapter spawn — explicit env, no secret leakage
const safeEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb' };
const proc = spawn('claude', [
  '-p', assembledPrompt,
  '--output-format', 'json',
  '--max-turns', String(def.maxTurns),
  '--allowedTools', JSON.stringify(def.allowedTools),
], { cwd: workspace.path, timeout: def.timeoutMs, env: safeEnv });
```

```typescript
// PreToolUse hook (shell script, stdin is JSON)
// .claude/hooks/containment.sh
// Reads tool call, checks against blocked patterns, exits 0 or 1
```

```typescript
// Workspace allocation from Docker pool
async function allocateWorkspace(branch: string): Promise<Workspace> {
  const container = await pool.take(); // grab pre-warmed container
  await git(['checkout', branch], container.workdir);
  await applyExclusions(container, containmentPolicy.excludedPaths);
  return { path: container.workdir, containerId: container.id };
}
```

## Gotchas

- `claude -p` with `--output-format json` writes JSON to stdout but may also write status messages to stderr. Always separate stdout and stderr parsing.
- The SDK's `query()` can throw on rate limits. Catch the specific error code and report to the rate limit handler — do not let it propagate as a session failure.
- Docker over SSH: the tunnel must be kept alive. Use a persistent SSH control socket (`ControlMaster`) with health checks. On connection failure, reconnect with exponential backoff. If the pool is unreachable, enter degraded mode (reject new workspace requests, let active sessions finish).
- PreToolUse hooks run synchronously in the CLI. A slow hook blocks the session. Keep hook logic fast — just pattern matching, no network calls.
- Container cleanup must happen in a `finally` block. A crash during session monitoring must not leave orphaned containers. The periodic cleanup flow (ARCH-AC-SESSION-RUNTIME) handles stragglers.
- `--json-schema` in the CLI Adapter expects a valid JSON Schema string. Validate the schema at startup, not at spawn time — fail fast.
- Docker containers provide environment isolation (dependencies, network, filesystem). Branch isolation within the container is managed by the Implementation Coordinator via git worktrees. The Session Runtime allocates the container; the Coordinator manages the worktree within it.
- SDK containment hooks must be a standalone module (`src/session-runtime/containment-hooks.ts`) with a frozen interface. Do not allow other modules to modify hook behavior at runtime. Test hooks independently.
- When spawning CLI processes, explicitly set `env` in the spawn options. Omitting `env` causes `process.env` to be inherited, leaking secrets to intelligent sessions.
