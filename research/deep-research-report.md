# Designing a Spec-Driven Autonomous Implementation Factory Inspired by Aperant, OpenClaw, autoresearch, and Superpowers

## What the four projects collectively teach

Taken together, the four references show a convergent design pattern for “walk-away” autonomy: keep the **human-facing intent** lightweight and editable (specs, instructions, skills), keep the **execution surface** tightly controlled (worktrees, sandboxes, permission rules), and keep the **orchestration** explicit and inspectable (queues, state machines, logs, deterministic deployment + verification). citeturn11view2turn15view0turn6view0turn21view2turn32view0

**Aperant** is essentially a productionised “multi-session agent factory” concept: multiple parallel agent terminals, git worktree isolation by default, a QA loop, and an emphasis on treating the orchestrator as a first-class product (desktop UI + agent layer) rather than a pile of scripts. Its README explicitly positions it as an “autonomous multi-agent coding framework” and highlights parallel execution plus worktree isolation, QA validation, and a persistent memory layer. citeturn11view2turn8view0

**OpenClaw** focuses on a different axis: a gateway/control-plane architecture that stays “always on”, routes requests across channels and tools, and treats configuration, secrets, and operational safety as core product features (schema validation, auth required by default, hot reload modes, background process management). citeturn16view0turn16view1turn19view1turn20view2

**entity["people","Andrej Karpathy","ai researcher"]’s autoresearch** is deliberately minimal but conveys a profound orchestration idea: constrain an autonomous loop by separating **(a) immutable harness**, **(b) mutable target**, and **(c) a scalar evaluation metric**, then iterate indefinitely while keeping diffs reviewable and the evaluation fair. In the README and `program.md`, the model is: only one file is edited, runs are time-boxed (5 minutes), results are logged, and changes are kept or discarded based on whether the validation metric improves. citeturn6view0turn26view0turn26view1

**Superpowers** is the strongest “methodology layer” of the four: it encodes software engineering discipline as composable “skills” (plan-writing, worktree usage, test-driven development, systematic debugging, code review, completion gates), and it emphasises chunking work into small, verifiable units with explicit commands. It explicitly describes a workflow: tease out a spec, show it in readable chunks, write an implementation plan with TDD + YAGNI + DRY, then run a subagent-driven process with two-stage review. citeturn21view0turn22view0turn22view1turn23view0turn24view2turn25view0

A key practical implication for your Auto-Claude design is that you do not need to “invent” all of the primitives yourself: modern Claude Code already provides **headless programmatic execution (`-p/--print`)**, **validated structured outputs (`--json-schema`)**, **worktree isolation (`--worktree`)**, **skills (AgentSkills)**, **subagents**, **hooks**, **permissions allow/ask/deny**, and **sandboxing controls**—all of which map almost directly onto what your draft spec calls a “daemon” plus “pipeline”. citeturn32view0turn32view1turn32view2turn30view3turn30view2turn33search0turn33search1turn32view3

## Pattern library you should copy, with provenance

Your draft is already close to a robust industrial pattern; the most valuable refinements come from “stealing” the exact hard-won mechanics each project documents.

### Worktree-first parallelism with explicit hygiene

Superpowers is unusually explicit about **worktree hygiene**: prefer `.worktrees/` or `worktrees/`, verify the directory is gitignored before creating worktrees, and always establish a clean test baseline before proceeding. citeturn23view1 This is not just pedantry: it prevents untracked-file noise, eliminates accidental commits of worktree artefacts, and gives you a “known good” baseline for failure attribution.

Claude Code’s own “common workflows” documentation reinforces the same core: parallel sessions need independent working directories, `--worktree` creates an isolated directory under `.claude/worktrees/<name>` and a corresponding branch, and cleanup behaviour differs depending on whether there are changes. citeturn32view2turn32view0

Aperant’s README makes the “all changes happen in git worktrees” claim a primary selling point, and it advertises “up to 12” parallel agent terminals, which implicitly means it has solved a large amount of coordination and isolation plumbing you can emulate. citeturn11view2turn8view0

**Design takeaway for Auto-Claude:** make “worktree hygiene” a first-class phase (create, initialise dependencies, verify baseline tests, allocate ports, track lifecycle, cleanup policy). Treat it as deterministic machinery, not an LLM decision.

### Skills as the unit of operationalised methodology

OpenClaw and Claude Code both converged on the **AgentSkills** standard: skills are folders with a `SKILL.md`, and the runtime loads them from defined locations with precedence rules and gating. OpenClaw documents three sources (bundled, `~/.openclaw/skills`, `<workspace>/skills`) and a precedence chain (workspace → user → bundled), plus load-time filtering based on OS/binaries/env/config. citeturn17view1turn17view2

Claude Code’s skills documentation similarly treats skills as the modern replacement for custom commands, uses AgentSkills as the base standard, and explicitly describes bundled skills like `/batch` that decompose work into units and run them in isolated worktrees. citeturn30view3turn32view2

Superpowers shows what “skills as methodology” looks like in practice: `writing-plans` mandates bite-sized tasks (2–5 minutes each) with exact file paths and commands, and `subagent-driven-development` codifies a two-stage review loop (spec compliance first, then code quality). citeturn22view0turn22view1

**Design takeaway for Auto-Claude:** your `prompts/*.md` folder is already “skills shaped”. Make it fully AgentSkills-compatible so you can:  
1) load it into Claude Code sessions in a standard way, and 2) reuse the same skill pack in both “interactive spec authoring” (Workflow A) and “autonomous factory runs” (Workflow B). citeturn17view1turn30view3turn22view0

### Control plane / operator ergonomics as stability multipliers

OpenClaw’s Gateway documentation reads like an ops runbook: one always-on process, a single multiplexed port, explicit health/readiness probes, and strong defaults like loopback binding + required auth. citeturn16view0turn16view1

Two details are especially transferable to your daemon:

* **Locking by port binding rather than PID files.** OpenClaw’s “Gateway Lock” explains a robust mechanism: bind the control socket early; if another process holds the port, fail fast; the OS releases locks on crash without stale files. citeturn19view0  
* **Background process management as a tool primitive.** The `exec`/`process` tool split (run commands, auto-background, poll logs later) is directly analogous to “deploy-dev then poll health checks”. citeturn19view1

**Design takeaway for Auto-Claude:** treat the daemon as a control plane with explicit “operator verbs” (status, logs, retry, resume, drain, lock) rather than a cron script. Your spec already gestures at this; OpenClaw provides a proven shape. citeturn16view0turn19view0turn19view1

### Secrets and permission boundaries are not optional for autonomous agents

OpenClaw’s secrets model is unusually mature: it resolves secrets into an in-memory “snapshot”, fails fast on startup if an active SecretRef cannot resolve, and uses atomic swap on reload (“all succeed or keep last-known-good”). citeturn20view2turn20view0 This is the exact stability behaviour you want for an always-on factory daemon that must not half-apply credential changes.

Claude Code also has a formal permission system (allow/ask/deny) and explicit sandboxing controls designed to reduce approval fatigue while maintaining boundaries. citeturn33search0turn33search1turn33search2

Aperant documents a three-layer security model (OS sandbox, filesystem restrictions, dynamic command allowlist), and it claims releases include checksums and VirusTotal scans. citeturn8view0turn11view2

OpenClaw extends this with an ecosystem-level approach: it describes deterministic packaging, hashing, and VirusTotal scanning (including Code Insight) for skills published to its marketplace, plus ongoing re-scans. citeturn18view0

**Design takeaway for Auto-Claude:** make secrets + permissions + sandboxing part of the base architecture, not a phase you “add later”. The moment you autopoll issues and run code unattended, your threat model becomes real. citeturn20view2turn33search1turn18view0turn11view2

### The “immutable harness + mutable target + metric” pattern is directly reusable for SDD

autoresearch frames the loop as:  
* `prepare.py` is effectively immutable and defines constants like the 5-minute budget (`TIME_BUDGET = 300`) and evaluation;  
* `train.py` is the only mutable file;  
* `val_bpb` is the metric;  
* experiments are logged; improvements are kept, regressions discarded. citeturn26view0turn26view1turn6view0

For your scenario, the analogues are:

* Immutable harness: your SDD scaffolding (traceability rules, scenario runner, CI steps, deployment and health checks).
* Mutable target: the codebase changes produced for an issue’s feature branch/worktrees.
* Metric(s): holdout scenarios, tests, lint/typecheck, deployment health.

**Design takeaway for Auto-Claude:** treat every issue as an “experiment run” with a recorded state, deterministic verification outputs, and explicit keep/discard/escalate transitions—just like autoresearch, but in software delivery terms. citeturn26view0turn6view0turn25view0

## A concrete Auto-Claude architecture that aligns with your draft and the evidence

Your draft describes “TypeScript daemon + Claude-as-coordinator”, with GitHub Issues as the queue and a multi-phase pipeline that ends in a dev deploy and a PR to `main`. That architecture is compatible with the strongest patterns above, but you can sharpen it by using **Claude Code’s own programmatic interface** as the execution substrate and keeping TypeScript focused on orchestration, state, and I/O. citeturn32view1turn32view0turn30view0turn11view2

### Core principle: the daemon should orchestrate *Claude Code sessions*, not emulate them

Claude Code’s CLI reference makes it explicit that `--print/-p` runs non-interactively, supports `--max-turns`, can return structured JSON via `--output-format json` + `--json-schema`, can constrain spend (`--max-budget-usd`), and can start inside a worktree with `--worktree`. citeturn32view0turn32view1

That means you can implement your coordinator + reporter steps as **headless Claude Code calls that return validated JSON**, rather than brittle stdout parsing.

Concretely, your “Phase 2: Decompose” can become something like:

* TypeScript assembles the issue payload + spec file contents or paths.
* Call `claude -p ... --output-format json --json-schema <TaskGraphSchema> --max-turns <N>`.
* Validate the `structured_output` field and persist it as `task-graph.json`. citeturn32view1turn32view0

This is a direct analogue to the “structured loop instructions” in autoresearch’s `program.md`: the human writes the meta-instructions, the agent follows them, and results are recorded in a standard format. citeturn26view0turn32view1

### Work partitioning: borrow Superpowers’ unit granularity discipline

Your task graph “units” should be shaped like Superpowers’ planning expectations: exact files, explicit verification commands, small steps, and commit discipline. citeturn22view0turn23view1

A practical approach is:

1) Coordinator produces a first pass “unit list” that is *coarse*, focusing on dependency order and file overlap prediction.  
2) Each unit’s worker (in its own worktree) runs a “writing-plans”-style pass to generate a bite-sized plan and then executes with TDD discipline. citeturn22view0turn23view0turn25view0

You don’t need to adopt Superpowers verbatim, but its decomposition and verification constraints map cleanly to your “unit pipeline in worktrees + N review cycles” concept. citeturn22view1turn24view0turn25view0

### Review: replace a single monolithic reviewer prompt with layered gates

Superpowers formalises layered gates:

* TDD gate (must observe failing test first). citeturn23view0  
* Verification-before-completion gate (no “done” claims without fresh command output). citeturn25view0  
* Code review gate. citeturn24view0  
* Finish-branch gate (tests must pass before offering merge/PR options). citeturn24view1  

Claude Code’s hook system gives you a mechanical way to enforce similar invariants: prompt- or agent-based hooks can block “Stop” until tests pass, for example. citeturn32view3turn25view0

**Recommendation:** implement review as a sequence of heterogeneous gates—some deterministic (tests), some LLM-based (style/edge-case review), some policy-based (permissions)—rather than N identical `/deep-review` loops. This aligns with the broader community critique (and even Claude Code’s own philosophy) that deterministic tools should handle what they’re definitively good at, while the LLM focuses on higher-order reasoning. citeturn32view3turn25view0turn30view0

### Daemon locking and survivability: prefer “port lock + state recovery” over PID files

Your draft proposes a PID lock file. OpenClaw documents a more crash-resilient mechanism: bind an exclusive port early; if it’s in use, fail fast; the OS cleans up on crash; optionally keep a lightweight PID guard as a convenience. citeturn19view0turn16view0

**Recommendation:** run your daemon with a local control socket (even if only a minimal HTTP interface for status). Use the control port as the lock and expose introspection endpoints (current issue, phase, logs). This will feel “OpenClaw-like” in operational behaviour while still being repo-scoped. citeturn16view0turn19view0

### Memory and traceability: treat it as structured data, not “chat history”

Aperant’s internal guidance describes a Graphiti-based knowledge graph memory system that retains insights across sessions, and it mentions MCP integration. citeturn10view2turn11view2

Graphiti itself positions as a temporal context graph engine intended for real-time knowledge graphs for agent memory. citeturn29search2

**Recommendation:** for an SDD factory, your “memory” should not primarily be conversational. Instead, prioritise:

* A **run ledger**: every phase, command, exit code, artefact, and diff summary stored in `run.json` (your spec already does this).  
* A **traceability index**: mapping spec IDs → code paths → tests → scenario IDs, updated deterministically during merges.  
* Optionally, a **Graphiti/MCP layer** that stores higher-level lessons (build commands, flaky tests, deployment gotchas) keyed by repo + stack, similar to Aperant’s approach. citeturn10view2turn29search2turn20view2

## Safety model and holdout integrity that stands up under real autonomy

Your holdout rule (“no agent may read scenarios”) is the right instinct. The main challenge is enforcing it mechanically, even when agents can run tools.

### Enforce “scenario blindness” at the tool boundary, not by prompt instruction

Prompt rules are advisory. Claude Code, however, is built around permissions and sandboxing boundaries you can configure centrally. citeturn33search0turn33search1turn33search2

Three layers (mirroring Aperant’s “layered security model”) are plausible:

1) **Claude Code sandbox/permissions denylist**: deny `Read` on `.specify/scenarios/**` (and any other holdout paths) at configuration level, so *even if* a worker tries to read them, the tool call cannot succeed. citeturn33search1turn33search0turn33search2  
2) **Hook-based policy**: add a `PreToolUse` hook that blocks any attempted access to holdout paths and returns an explicit “do not reveal holdouts” reason into the agent’s loop. Hooks can be command-based (deterministic) or LLM-based (policy reasoning), but for this use case deterministic matching is preferable. citeturn32view3turn25view0  
3) **Out-of-band execution**: run holdout scenarios outside Claude Code entirely (as your draft states), report only scenario IDs and pass/fail counts, not scenario content—analogous to how autoresearch keeps the evaluation harness fixed and treats it as ground truth. citeturn26view0turn25view0

This triple approach ensures the guarantee is not “trust the agent”, but “the agent literally cannot see the holdouts, and verification happens outside the agent”.

### Treat skills/plugins as a supply-chain surface

OpenClaw’s security write-up is explicit that skills are code running in the agent’s context and could exfiltrate data or execute payloads. citeturn18view0turn17view1

If your Auto-Claude uses prompt packs, scripts, hooks, or plugins, you have a similar supply-chain problem. OpenClaw’s marketplace pipeline (deterministic packaging → hash → VirusTotal scanning → block/flag) is a strong template, even if you implement it locally rather than through a public marketplace. citeturn18view0

Claude Code also supports managed settings and marketplace restriction controls (e.g., restricting plugin sources) and documents configuration scopes (managed/user/project/local), which you can repurpose as “factory policies” that cannot be overridden by workers. citeturn30view1turn33search6turn33search22

### Avoid “YOLO mode” in production-like repos unless you have *real* sandboxing

Claude Code documentation describes bypass-permissions mode as equivalent to `--dangerously-skip-permissions` and explicitly cautions it should only be used in sandboxed containers/VMs, with admin ability to disable it. citeturn33search4turn33search1

Aperant’s README and OpenClaw’s docs both reflect a philosophy of defence-in-depth rather than blind trust. citeturn8view0turn18view0turn16view0

**Recommendation:** design Auto-Claude so that unattended runs happen inside a constrained environment (container, VM, or Claude Code’s sandbox mode with filesystem/network restrictions), and make the “permissions bypass” a last resort rather than the default. citeturn33search1turn33search4turn8view0

## Implementation roadmap shaped by the proven primitives

The simplest path to a robust MVP is to implement only what the daemon must own (queueing, state, persistence, notifications, and deterministic commands) and offload as much “agent runtime” as possible to Claude Code’s headless mode and its native capabilities. citeturn32view1turn32view0turn30view0

### MVP that already delivers “spec → dev deployed → report”

A tight MVP can be:

* **Issue polling and claiming**: use `gh issue list` / labels as your queue, as you propose, but store a full local run ledger from the start (run ID, issue number, repo SHA, timestamps). This mirrors the “results.tsv + branch loop” discipline in autoresearch—everything is recorded, even failures. citeturn26view0turn32view0  
* **Coordinator JSON output**: call `claude -p --output-format json --json-schema …` to generate `task-graph.json`. You get validated structured output instead of “best effort” parsing. citeturn32view1turn32view0  
* **Single-worker execution**: one unit at a time in a git worktree (either via `git worktree add` or `claude --worktree`), with a strict “tests must pass” rule before commit, reflecting Superpowers’ “verification before completion” and “finish branch” gates. citeturn32view2turn25view0turn24view1  
* **Deterministic holdout runner**: run scenarios outside Claude Code; only return pass/fail metadata. citeturn26view0turn25view0  
* **Dev deploy + health check poll**: implement as deterministic shell commands, modelled after OpenClaw’s “operator command set” and liveness/readiness checks. citeturn16view0turn19view1  
* **Report**: use a headless Claude call as a summariser, but constrain it with a JSON schema or a fixed markdown template (and include test outputs + diff stats). citeturn32view1turn32view0turn25view0

This MVP already gives you the core promise: queue → implement → verify → deploy → notify.

### Scaling from MVP to “parallel factory”

Once the above works, parallelism and robustness become incremental:

* **Batch-level parallelism**: your “non-overlapping file batches” concept matches Claude Code’s own `/batch` philosophy (decompose into independent units, isolated worktrees). Decide whether you want the daemon to own the partitioning, or whether to lean on Claude Code’s unit decomposition and treat it as a subroutine. citeturn30view3turn32view2turn22view1  
* **Long-running process management**: adopt an OpenClaw-style background process abstraction (spawn → session ID → poll logs) for deployment and test runners. This prevents tool output flooding and improves recoverability. citeturn19view1turn26view0  
* **Secrets hygiene**: implement OpenClaw-like “snapshot resolve + atomic swap” semantics for credentials used by the daemon (GitHub tokens, deploy keys, Slack webhooks), so a partial reload can’t wedge your factory mid-run. citeturn20view2turn20view0  
* **Cost and runaway controls**: use `--max-turns` and `--max-budget-usd` for headless Claude execution so any stuck loop is bounded; this is especially relevant for autonomous pipelines. citeturn32view0turn32view1  
* **Policy enforcement**: use Claude Code permissions and hooks to encode non-negotiables (no reading holdouts, no writing outside repo, no network except approved endpoints, etc.). citeturn33search0turn33search1turn32view3

### Where your draft should be adjusted for compatibility with current Claude Code behaviour

Your draft command snippets will work better if aligned with the current CLI contract:

* `--print` and `-p` are the same flag (print/headless mode), so you typically use one, not both. citeturn32view0turn32view1  
* Print mode can still run agentic workflows and can be constrained with `--max-turns` and structured output options (`--output-format json`, `--json-schema`). citeturn32view0turn32view1  
* Worktree isolation is supported natively via `--worktree/-w`, and Claude Code cleans up worktrees automatically when no changes exist, prompting otherwise; this can simplify your `.factory/worktrees` lifecycle management if you accept its directory conventions. citeturn32view2turn32view0  
* Hooks can be prompt-, agent-, command-, or HTTP-based; this gives you a powerful enforcement mechanism for “stop conditions” and policy gates that goes beyond prompting. citeturn32view3turn25view0

These adjustments reduce “drift risk” between your orchestrator and the underlying tool you’re orchestrating.

## Closing synthesis: the “Auto-Claude” you are describing is a composition of proven building blocks

Your current draft is directionally consistent with what the ecosystem’s strongest implementations already do:

* **Aperant** validates that multi-session + worktree + QA loops + memory are a viable product shape, and it shows concrete security posture patterns (sandboxing, restrictions, allowlists). citeturn11view2turn8view0turn10view2  
* **OpenClaw** validates that always-on “agent control planes” need hard ops primitives: robust locking, strict config, explicit health checks, background process management, and mature secrets semantics. citeturn16view0turn19view0turn19view1turn20view2  
* **autoresearch** validates that autonomy scales when you constrain the editable surface and treat evaluation as immutable ground truth, with explicit keep/discard logic. citeturn26view0turn6view0turn26view1  
* **Superpowers** validates that you get far better outcomes by encoding “how we build software” into explicit, reusable skills with verification discipline, small steps, and layered review gates. citeturn21view2turn22view0turn22view1turn23view0turn25view0  
* **Claude Code’s current CLI + hooks + permissions + sandboxing** provide the execution substrate your daemon can orchestrate, drastically reducing the amount of bespoke agent-runtime code you need to maintain. citeturn32view0turn32view1turn33search0turn33search1turn32view3turn30view3