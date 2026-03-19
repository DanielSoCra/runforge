Auto-Claude: The Architecture of Autonomous, Self-Improving Agentic Software Development Systems
The Paradigm Shift in Automated Engineering
The landscape of software development is undergoing a fundamental transition from reactive, human-prompted coding assistants to proactive, autonomous, and self-improving agentic orchestrators. Historically, large language models (LLMs) operated within a stateless, conversational paradigm where human engineers manually interpreted specifications, directed the model, reviewed the output, and integrated the code. This model inherently suffers from context degradation, cognitive debt, and bottlenecked feedback loops. As autonomous task complexity doubles at rapid intervals, the limitations of the conversational interface become the primary bottleneck to engineering velocity.1
The proposed "Auto-Claude" architecture represents a comprehensive plan to transcend these limitations by implementing a fully autonomous Specification-Driven Development (SDD) pipeline. By synthesizing the architectural principles of continuous daemon operations, rigorous subagent-driven task decomposition, fixed-metric autonomous feedback loops, and self-generating skill memory, it is possible to construct a factory-like orchestrator. In this paradigm, human engineers transition from writing logic to writing specifications, shifting their role from line-level programmers to system architects who define the rules of an immutable arena.2
This analysis provides an exhaustive blueprint for the Auto-Claude framework, demonstrating how concepts from cutting-edge agentic repositories—Aperant, OpenClaw, Autoresearch, and Superpowers—integrate into a highly structured, self-improving suite of software engineering agents.
The B+C Hybrid Paradigm: Decoupling Machinery from Intelligence
A fundamental vulnerability of naive autonomous agents is the conflation of deterministic system operations with non-deterministic probabilistic intelligence. When an LLM is forced to manage its own state, track background processes, or handle network timeouts, the system becomes fragile. The Auto-Claude architecture resolves this through a "B+C Hybrid" approach: a TypeScript Daemon (the machine) paired with Claude-as-Coordinator (the brain).
The Deterministic TypeScript Daemon
The orchestration layer is constructed as a continuous, background-running daemon, adopting the 24/7 operational model pioneered by the OpenClaw framework.4 The TypeScript daemon handles all deterministic machinery: GitHub API polling, process lifecycle management, state tracking via local JSON structures, notification dispatch, and restart loops.
By running as a persistent Node.js or Deno service (managed by launchd on macOS or systemd on Linux), the daemon ensures that the system is "always on" and capable of proactive execution.4 It does not rely on a human to initiate a terminal session; it continuously polls asynchronous queues for implementation requests.5 The daemon is entirely devoid of intelligence; it strictly follows a hardcoded state machine, ensuring absolute predictability in how tasks are routed, worktrees are created, and costs are tracked.
The Non-Deterministic Intelligence Engine
Conversely, all cognitive functions—spec decomposition, dependency analysis, code implementation, peer review, and report generation—are delegated to isolated, ephemeral Claude Code CLI sessions. The daemon orchestrates these sessions using the @anthropic-ai/claude-code CLI, leveraging its built-in tools, CLAUDE.md context loading, and context management.
This strict boundary ensures that if an LLM hallucinates or enters an infinite loop, the failure is contained within a child process. The TypeScript daemon monitors the process execution time against configured timeouts (e.g., worker_timeout_minutes: 60), forcefully terminating any stuck intelligence sessions and gracefully resuming the state machine.4
Component Architecture
The physical structure of the Auto-Claude daemon reflects this separation of concerns, ensuring modularity and extensibility. The system is partitioned into highly specialized modules:

Module Directory
Primary Function
Architectural Precedent
src/queue/
Manages GitHub API polling, claim locks, and parses markdown issue bodies into structured payloads.
OpenClaw's event gateway and channel routing.4
src/pipeline/
The core state machine orchestrating the 9-phase lifecycle (Detect, Decompose, Implement, Review, Test, PR, Deploy).
Superpowers' sequential operational phases.7
src/claude/
Spawns and manages Claude CLI child processes, captures stdout/stderr, and manages Git worktree lifecycles.
Aperant's OS sandbox and terminal virtualization.5
src/state/
Reads and writes the atomic run.json state, ensuring nondeterministic idempotence and crash resumability.
Autoresearch's structured K-experiment logging.9
src/notify/
Dispatches asynchronous webhooks to Slack, Email, or Markdown reports based on YAML configuration.
OpenClaw's multi-channel notification architecture.4

Queue Management and the Git-Backed State Machine
A critical design decision in the Auto-Claude architecture is the rejection of proprietary databases for task queuing. Instead, GitHub Issues serve as the universal interface, queue, and state machine. This aligns the agent's workflow directly with existing human engineering practices (GitOps), ensuring that the system remains transparent, auditable, and easily modifiable.
Decoupled Workflows
The architecture relies on two entirely decoupled workflows connected via the GitHub Issue queue:
Workflow A (Spec Authoring): This is a human-in-the-loop, interactive process. A human engineer utilizes an interactive Claude Code session to brainstorm, refine requirements, and draft L1 (Functional), L2 (Architectural), and L3 (Stack) specifications. This mirrors the "Socratic design refinement" phase of the Superpowers framework, where rough ideas are teased into rigid specifications before any code is written.7 Once the specs are finalized, the author outputs a highly structured GitHub Issue labeled factory-ready.
Workflow B (Spec Factory): This is the fully autonomous execution pipeline. The Auto-Claude daemon picks up the factory-ready issue, runs the implementation lifecycle, commits to a dev branch, and eventually prepares a release PR to main.
The Contractual Issue Format
The GitHub Issue body acts as a rigid contract between Workflow A and Workflow B. It is not a conversational prompt; it is a structured payload containing:
A declarative summary.
Explicit pointers to specification files (e.g., FUNC-SPEC-ID:.specify/functional/user-auth.md).
A strict bulleted scope of expected changes.
Testable acceptance criteria.
YAML-style configuration parameters (e.g., has_ui: true, deep_review_rounds: 7).
The Label State Machine
The daemon utilizes GitHub Issue labels to track state transitions, eliminating the need for an external database. The standard feature transition flows from factory-ready to factory-in-progress and finally to factory-complete.
However, the architecture anticipates failure modes and includes robust error recovery paths:
Holdout Failures: If the implementation fails the blind holdout testing, the daemon transitions the label to needs-spec-update, correctly identifying that the failure is a specification gap rather than a coding error.
Error Recovery: If an agent exhausts its maximum retry limits (e.g., max_retries_per_phase: 3), the daemon labels the issue factory-stuck. This pauses the pipeline and notifies the human operator. The human can inspect the logs, correct the underlying environmental issue, and manually relabel the issue to factory-ready to force a retry from scratch.
Instance Concurrency and Lock Files
To prevent race conditions where multiple daemons attempt to process the same issue, the system enforces a strict single-instance policy per repository. On startup, the daemon attempts to create an exclusive lock file (~/.auto-claude/state/{repo-path-hash}/daemon.lock) containing its Process ID (PID).
If the lock file exists, the daemon checks the liveness of the PID via process.kill(pid, 0). If the process is dead, the stale lock is aggressively collected and deleted. This defensive engineering ensures that the factory remains highly available even after unexpected server reboots or kernel panics, adhering to the resilience required of a true 24/7 daemon.4
The 9-Phase Implementation Pipeline
The execution of a factory issue follows a rigid, 9-phase pipeline. This pipeline enforces the structural constraints necessary to prevent the LLM from optimizing for the shortest path—a known anti-pattern where agents write monolithic, untested code blocks.10
Phase 1: Detect
The daemon continuously polls the GitHub API via a cron schedule (e.g., interval_minutes: 5) executing the equivalent of gh issue list --label "factory-ready". Upon detection, the daemon claims the issue by swapping the label to factory-in-progress, parses the markdown body into an IssuePayload object, and initializes a local run.json state file. This file ensures non-deterministic idempotence; if the daemon crashes during Phase 4, upon restart it will read run.json and resume exactly at Phase 4.
Phase 2: Socratic Decomposition
Large context windows degrade the reasoning capabilities of LLMs. Dumping an entire feature specification into a single agent prompt guarantees missed edge cases and superficial implementations. To solve this, Auto-Claude utilizes a one-shot "Coordinator" session.
The daemon spawns a high-reasoning model (e.g., Claude 3.5 Opus) with a heavily structured prompt (coordinator.md). The Coordinator reads the issue body, the L1/L2/L3 specification files, and the traceability.yml matrix. Its sole objective is to decompose the feature into an acyclic task graph.
The output is a task-graph.json file. Each node (unit) in this graph represents a bite-sized chunk of work with no file-level overlap with concurrent nodes. This methodology is directly adapted from the Superpowers writing-plans skill, which mandates that work be broken into tasks taking 2-5 minutes, complete with exact file paths and verification steps.7 The daemon batches these units so that independent tasks can run in parallel, drastically reducing wall-clock completion time.
Phase 3: Isolated Implementation and TDD Enforcement
For each unit in a batch, the daemon spins up a completely isolated workspace using Git worktrees (.factory/worktrees/unit-X). This is a critical architectural borrowing from Aperant and Superpowers.5 Worktrees provide total isolation, allowing parallel agents to modify, compile, and break code simultaneously without cross-talk, context pollution, or race conditions on the main branch.5
Within the worktree, the daemon spawns a "Worker" agent. The worker is governed by an "Iron Law" embedded in its system prompt (worker.md), which enforces a mandatory Test-Driven Development (TDD) workflow.7
Read: The agent ingests the specific spec layers assigned to its unit.
Plan: It writes a micro-implementation plan.
RED-GREEN-REFACTOR: It writes a failing test. It runs the test suite to verify failure. It writes the implementation code. It runs the test suite to verify success.7
Review: It runs an internal /deep-review cycle to self-correct before signaling completion.
Once all workers in a batch complete their units, the TypeScript daemon merges the worktrees back into the unified feature branch using git merge --no-ff to preserve traceability. If the Coordinator mispredicted file overlap and a merge conflict occurs, the daemon spawns a highly specialized conflict-resolver.md agent to resolve the diff in favor of the spec intent.
Phase 4: N-Round Deep Review
Autonomous agents cannot be trusted to self-certify complex integrations. Once a batch is merged, the daemon initiates a multi-stage review process on the unified feature branch.
This phase spawns dedicated "Reviewer" agents. Emulating the Subagent-Driven Development (SDD) process, these agents do not write novel feature code; their prompts are specifically tuned for adversarial critique.7 The review rounds are configured via the YAML file (e.g., deep_review_rounds: 7).
Early Rounds: Focus exclusively on specification compliance—did the implementation worker actually build what was defined in the L1/L2 specs?.8
Middle Rounds: Focus on code quality, architectural patterns, YAGNI (You Aren't Gonna Need It) principles, and security vulnerabilities.7
Late Rounds: Focus on edge cases, race conditions, and polish.
If a reviewer finds an issue, a worker is respawned to fix it. This adversarial, multi-agent cross-reflection loop mathematically increases the probability of catching logical flaws before deployment.12
Phase 5: Holdout Validation (The Immutable Arena)
Phase 5 is the most critical trust mechanism in the entire Auto-Claude architecture. It borrows heavily from the karpathy/autoresearch paradigm, where the agent is forced to operate within an "immutable arena" governed by a fixed evaluation metric that it cannot alter.2
In Auto-Claude, this arena takes the form of Holdout Scenarios. These are strict behavior-driven development tests stored in .specify/scenarios/.
Strict Isolation: No Claude agent—neither Coordinator, Worker, nor Reviewer—is ever permitted to read or access the .specify/scenarios/ directory. This rule is enforced technologically; when the daemon creates the Git worktrees for the implementation agents, it uses sparse checkouts to explicitly exclude the scenarios directory from the filesystem.5
Objective Verification: Once the code is merged and reviewed, the TypeScript daemon (not an LLM) executes a shell-based test runner against the implementation.
Proof of Generalization: Because the agents never saw the test scenarios, passing the suite provides cryptographic-level proof that the agents generalized the solution from the semantic specification, rather than simply writing overfitted code designed to pass a visible test file.5
If a holdout scenario fails, it is mathematically impossible for it to be an implementation bug (since the code passed the L3 specs and unit tests). A failure here definitively indicates a gap in the L1/L2 specifications. The daemon captures the structured failure output, labels the issue needs-spec-update, and halts the pipeline. The agents are not allowed to "hack" the code to pass the test; the human must update the spec.
Phases 6-8: PR, Deploy, and Dynamic Testing
With the code objectively verified, the daemon transitions to standard DevOps automation.
Phase 6 (PR to Dev): A pull request is created from the feature branch to the dev branch. A final, highly focused /deep-review is executed solely on the PR diff before the daemon auto-merges it.
Phase 7 (Deploy to Dev): The daemon executes the configured deploy_command (e.g., bin/deploy-staging) and polls the health_check_url until the environment is live and stable.
Phase 8 (Smoke + UI Tests): Against the live dev server, the daemon runs configured API smoke tests and Playwright UI tests. If a failure occurs at this integration layer, the daemon captures the structured error logs, creates a fix branch (e.g., factory/issue-42-fix-1), and spawns a worker agent with the failure context to patch the live integration issue.5
Phase 9: Reporting and The Human Gate
Upon passing all tests, the daemon spawns a "Reporter" agent (using a cheaper, faster model like Claude 3.5 Sonnet) to ingest the Git diff, test results, and review summaries. It generates a highly readable Markdown implementation report, posts it to the GitHub issue, closes the issue, and dispatches webhooks to Slack/Email.
The Release Gate: Production deployment is not performed on a per-issue basis. Auto-Claude batches completed issues and periodically (or on-demand) generates a release PR from dev to main.
This is the singular human gate in the entire architecture. The human architect reviews the aggregated release notes, the spec traceability matrix, and the dev server status. Merging the PR triggers standard GitHub Actions to handle the actual production deployment. The daemon strictly waits; it proposes, but the human disposes.13
Defensive Architecture: Containment, Safety, and Economics
Granting an autonomous agent full filesystem and network access via flags like --dangerously-skip-permissions introduces severe operational and security risks.14 Without rigorous constraints, an agent could overwrite system files, exfiltrate environment variables, or enter an infinite loop of recursive prompt calls, racking up thousands of dollars in API charges. Auto-Claude mitigates these risks through a defense-in-depth architecture.
Worktree Sandboxing and Prompt Prohibitions
The physical containment of the agent relies on the Git worktree isolation pattern.5 The worker agent is spawned into a directory that is functionally disjointed from the main repository. Furthermore, the agent's behavior is restricted by prompt-level constraints. The worker.md and reviewer.md templates contain explicit prohibitions:
Never read .specify/scenarios/.
Never modify files outside the immediate worktree scope.
Never modify the daemon's own TypeScript source code located in src/. This mirrors the Autoresearch architecture, where the prepare.py evaluation script is strictly off-limits to the agent modifying train.py.2 The rules of the arena cannot be rewritten by the gladiator.
Post-Session Auditing
To ensure compliance with prompt prohibitions, the TypeScript daemon performs a deterministic post-session audit. After the Claude CLI process exits, the daemon parses the generated .log files. It scans the absolute file paths accessed or modified during the session. If the daemon detects that the agent attempted to read a forbidden path or execute a blacklisted shell command, the system triggers a containment breach protocol. The worktree is immediately nuked, the issue is labeled factory-stuck, and a high-priority alert is dispatched to the human operator.
Economic Circuit Breakers
Autonomous agents operate at machine speed. A failed integration test could trigger a reflection loop that spawns dozens of high-parameter LLM calls within minutes. To prevent runaway costs, the daemon implements strict economic circuit breakers.
The factory.config.yaml file requires a pricing matrix that maps input/output tokens to USD costs for various models (e.g., Opus, Sonnet).
Capture: After every session, the daemon extracts the token usage metadata generated by the Claude CLI.
Accumulation: The daemon converts these tokens to USD and adds them to the totalTokenCostUsd in the run.json state file, aggregating a global daily cost counter in daemon.json.
Enforcement: Before spawning any new process, the daemon evaluates dailyCostUsd against the safety.daily_budget_usd configuration limit. If the budget is exhausted, the daemon enters a paused state, refusing to process new queue items until the human operator resets the budget or the 24-hour window expires.16
The Epistemology of Bug Triage and Continuous Evolution
In a traditional engineering environment, a bug is simply an error in the code. In an autonomous SDD environment, a bug is an epistemological failure—a breakdown in the translation of intent, specification, or capability. Auto-Claude treats bug handling not as a chore, but as the primary engine for recursive self-improvement.
When an issue labeled bug enters the queue, the daemon does not immediately attempt to fix the code. It spawns a "Diagnostician" agent to analyze the stack trace, the code, and the L1/L2 specifications to classify the failure mode.17
Type A: Implementation Bugs (Capability Gaps)
A Type A failure occurs when the specification is mathematically sound and comprehensive, but the code deviates from it. This represents a capability gap or a hallucination by the implementation agent.17
Resolution: The daemon routes the bug through a targeted auto-fix pipeline. It skips the Socratic decomposition phase and directly spawns a worker agent in a dedicated fix branch. Using the bug-worker.md prompt, the agent is forced to write a regression test that reliably reproduces the bug. Once the test fails, the agent fixes the code to make it pass, effectively closing the capability gap without altering the system's foundational logic.
Type B: Specification Gaps (Complexity Barriers)
A Type B failure is far more profound. It occurs when the code executes exactly as specified, but the system still fails in production or during holdout testing. This indicates that the specification itself is incomplete, contradictory, or failed to account for environmental complexities.17
Resolution: An agent cannot fix a Type B bug by writing code, because the code is already compliant with the flawed spec. Instead, the daemon labels the issue needs-spec-update and posts a structured diagnosis suggesting edits to the Markdown specification documents.
This creates a powerful feedback loop. By identifying and highlighting Type B failures, the AI forces the human (or a secondary spec-authoring agent) to refine the L1/L2 documents. Over time, the specification repository becomes an ultra-hardened, mathematically precise contract, evolving based on empirical failure data.
Type C: Expectation Mismatches
A Type C failure occurs when both the specification and the code are logically sound, but the human user simply desired a different outcome or behavioral aesthetic.
Resolution: The diagnostician agent, recognizing that no logical error exists, outputs a low confidence score (e.g., < 0.7) and labels the issue needs-human. The system refuses to guess at subjective preferences, forcing the human to rethink the L1 requirement and explicitly alter the high-level intent.
Persistent Context: Temporal Knowledge Graphs and Agentic Memory
A major limitation of independent LLM sessions is context amnesia. A worker agent might discover that a specific third-party API requires a unique authentication header, successfully implement it, and terminate. The next day, a different worker agent tasked with integrating a new endpoint for that same API will fail, having to relearn the exact same quirk from scratch.18
To solve this, Auto-Claude integrates a continuous memory layer, expanding upon the architectural concepts found in Aperant's Graphiti integration and OpenClaw's cross-agent memory.4
The Extraction and Promotion Pipeline
Auto-Claude maintains a hidden .learnings/ directory to facilitate system-wide memory.19 Whenever a worker agent encounters a significant compilation error, API timeout, or requires a complex workaround, it is instructed to log the event to an ERRORS.md or LEARNINGS.md file.
These logs are not simply dumped into the context window. The daemon runs a periodic asynchronous memory extraction pipeline:
Deduplication: The daemon analyzes the logs, grouping similar failures using a stable Pattern-Key.19
Threshold Evaluation: If a specific pattern hits a Recurrence-Count threshold (e.g., the same authentication error occurs 3 times across different tasks within 30 days), the daemon flags it as a systemic capability gap.19
Prompt Hot-Reloading: The daemon dynamically rewrites the project's global CLAUDE.md, TOOLS.md, or SKILL.md files to explicitly document the solution (e.g., "CRITICAL: When calling the Stripe API, always append the idempotency key").19
Because the daemon injects these files into every subsequent Claude session, the newly discovered knowledge immediately propagates across the entire swarm. This enables true recursive self-improvement. The agents are not just writing application code; they are continuously rewriting their own operating instructions and prompt templates based on empirical interactions with the codebase.20
Temporal Knowledge Graphs
For deeper architectural understanding, the memory layer can utilize temporal knowledge graphs.22 When a major feature is merged, the daemon processes the Git diff through an extraction agent. This agent updates a local graph database, mapping the new relationships between components, data flows, and dependencies.22
When a future Coordinator agent begins Socratic decomposition, the daemon queries this knowledge graph and injects a highly condensed, relevant topology map into the prompt. This allows the LLM to navigate massive, legacy enterprise codebases without requiring the entire source code to be stuffed into its context window, vastly improving reasoning accuracy and token efficiency.22
Conclusion
The transition from AI as a reactive chat interface to an autonomous software factory requires a paradigm shift in architectural design. The Auto-Claude framework achieves this by synthesizing the most robust concepts from contemporary agentic research.
By utilizing the continuous background operations of OpenClaw's daemon 4, the rigid subagent-driven workflows and TDD enforcement of Superpowers 7, the isolated terminal environments and memory graphs of Aperant 5, and the immutable evaluation arenas of Autoresearch 2, the architecture safely decouples human intent from machine execution.
This system does not attempt to make a single LLM artificially "smarter." Instead, it builds a deterministic, highly resilient machine around the non-deterministic intelligence. Through aggressive context isolation, objective holdout verification, and continuous extraction of Type B specification gaps, the Auto-Claude architecture transforms software development into a self-monitoring, recursively improving industrial pipeline.
Works cited
OpenClaw AI Agents as Informal Learners at Moltbook: Characterizing an Emergent Learning Community at Scale - arXiv, accessed March 14, 2026, https://arxiv.org/html/2602.18832v1
karpathy/autoresearch: AI agents running research on single-GPU nanochat training automatically - GitHub, accessed March 14, 2026, https://github.com/karpathy/autoresearch
The Fixed Metric - DEV Community, accessed March 14, 2026, https://dev.to/dannwaneri/the-fixed-metric-25im
OpenClaw — Personal AI Assistant, accessed March 14, 2026, https://openclaw.ai/
AndyMik90/Aperant: Autonomous multi-session AI coding - GitHub, accessed March 14, 2026, https://github.com/AndyMik90/Aperant
OpenClaw Architecture & Setup Guide (2026) - Valletta Software, accessed March 14, 2026, https://vallettasoftware.com/blog/post/openclaw-2026-guide
obra/superpowers: An agentic skills framework & software development methodology that works. - GitHub, accessed March 14, 2026, https://github.com/obra/superpowers
subagent-driven-development | Skills... - LobeHub, accessed March 14, 2026, https://lobehub.com/it/skills/obra-superpowers-subagent-driven-development
AutoResearch-RL: Perpetual Self-Evaluating Reinforcement Learning Agents for Autonomous Neural Architecture Discovery - arXiv, accessed March 14, 2026, https://arxiv.org/html/2603.07300v1
Stop Prompting, Start Managing. How I Built a Discipline System That… | by Israel Zablianov | Wix Engineering - Medium, accessed March 14, 2026, https://medium.com/wix-engineering/stop-prompting-start-managing-9eac9426930f
microsoft/amplifier-bundle-superpowers - GitHub, accessed March 14, 2026, https://github.com/microsoft/amplifier-bundle-superpowers
Inside the Minds of Machines: Agentic Design Patterns Every AI Builder Should Know, accessed March 14, 2026, https://hdst.medium.com/inside-the-minds-of-machines-agentic-design-patterns-every-ai-builder-should-know-78c10d9f5823
Self-Improving Coding Agents - Addy Osmani, accessed March 14, 2026, https://addyosmani.com/blog/self-improving-agents/
OpenClaw Security Engineer's Cheat Sheet - Semgrep.dev, accessed March 14, 2026, https://semgrep.dev/blog/2026/openclaw-security-engineers-cheat-sheet/
How to use OpenClaw safely - Gen Digital, accessed March 14, 2026, https://www.gendigital.com/blog/insights/leadership-perspectives/how-to-use-openclaw-safely
How to Run OpenClaw: Terminal, Daemon, TUI & Cloud [Full Walkthrough] - Dextra Labs, accessed March 14, 2026, https://dextralabs.com/blog/how-to-run-openclaw/
What Makes a Good LLM Agent for Real-world Penetration Testing? - arXiv, accessed March 14, 2026, https://arxiv.org/html/2602.17622v1
Gallery | WeaveHacks 3: Self-Improving Agents Hackathon with Weights & Biases, accessed March 14, 2026, https://cerebralvalley.ai/e/weave-hacks-3-self-improving-agents-hackathon-with-weights-and-biases-7014fe80/hackathon/gallery
skills/skills/pskoett/self-improving-agent/SKILL.md at main ... - GitHub, accessed March 14, 2026, https://github.com/openclaw/skills/blob/main/skills/pskoett/self-improving-agent/SKILL.md
Skills - OpenClaw, accessed March 14, 2026, https://docs.openclaw.ai/tools/skills
Building Openclaw from Scratch — Part 3 (The Meta Skill), accessed March 14, 2026, https://systemdesigner.medium.com/building-openclaw-from-scratch-part-3-the-meta-skill-15a50fcb4384
Building AI Agents with Knowledge Graph Memory: A Comprehensive Guide to Graphiti | by Saeed Hajebi | Medium, accessed March 14, 2026, https://medium.com/@saeedhajebi/building-ai-agents-with-knowledge-graph-memory-a-comprehensive-guide-to-graphiti-3b77e6084dec
Graphs Meet AI Agents: Taxonomy, Progress, and Future Opportunities - arXiv, accessed March 14, 2026, https://arxiv.org/html/2506.18019v1
A-Mem: Agentic Memory for LLM Agents | OpenReview, accessed March 14, 2026, https://openreview.net/forum?id=FiM0M8gcct
