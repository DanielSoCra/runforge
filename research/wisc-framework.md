# The WISC Framework: A Comprehensive Guide to Working with Claude Code

**Author:** Manus AI
**Date:** March 19, 2026

## Introduction

As AI coding assistants like Claude Code become more integrated into software development workflows, developers face a significant challenge: **Context Rot**. Context rot occurs when an AI's performance degrades over long conversations as the context window fills up with irrelevant information, dead ends, and noise. This leads to the AI forgetting instructions, hallucinating, or repeating mistakes.

Based on over 2,000 hours of practical experience by Cole Medin, the **WISC Framework** was developed to solve this problem. WISC is a battle-tested methodology designed to make AI coding reliable, even on massive, enterprise-level codebases. It treats context not as a prompt, but as an engineered product.

This document provides a detailed breakdown of the WISC framework and how to implement it effectively with Claude Code.

![WISC Framework Diagram](wisc_framework_diagram.webp)

---

## The WISC Framework Core Strategies

The WISC acronym stands for four core strategies: **Write**, **Isolate**, **Select**, and **Compress**. The ordering is intentional: Write and Isolate have the most impact, Select acts as a force multiplier, and Compress serves as a safety net.

### 1. W - WRITE: Externalize Your Agent's Memory

The fundamental principle of the "Write" strategy is to never rely solely on the AI's conversation history (RAM) for important information. Instead, externalize the agent's memory to persistent files (Disk) so it survives context resets.

**Key Practices:**

*   **Git Log as Long-Term Memory:** Use enriched commits to store context. A commit shouldn't just say *what* changed, but *why*. Include a `Context:` section in the commit body that logs changes to rules, commands, or docs alongside code changes.
*   **Structured Planning (`spec.md`):** Before writing code, use the AI to research and generate a detailed implementation plan (a Product Requirements Prompt or PRP). Save this plan to a file (e.g., `spec.md` or `plan-feature.md`). This plan becomes the definitive guide for a fresh implementation session, eliminating the noise of the planning conversation.
*   **Progress Files & Decision Logs (`HANDOFF.md`):** When a session runs long or work needs to be paused, create a handoff document. This file should capture the current state, completed tasks, key decisions (and *why* they were made), dead ends to avoid, and the recommended next action. The next session can read this file and pick up immediately without losing context.

### 2. I - ISOLATE: Sub-Agents Keep Your Main Context Clean

Researching a codebase or searching the web generates a massive amount of token noise. The "Isolate" strategy involves using sub-agents (or "scouts") to perform these exploratory tasks in isolation, keeping the main context window clean and focused.

**Key Practices:**

*   **The Scout Pattern:** Instead of having the main agent read a 1,000-line reference document, a sub-agent reads the document's header or summary first to determine relevance. It only loads the full document if necessary, and then returns a concise summary to the main agent.
*   **Parallel Research:** When planning a feature, spawn separate sub-agents to investigate different aspects simultaneously (e.g., one for affected packages, one for interface contracts, one for test patterns). They explore thousands of tokens but return only the essential findings.
*   **Exploration vs. Implementation:** Never mix deep exploration with implementation in the same session. Use an isolated session to explore and write a plan, then use a fresh, clean session to execute that plan.

### 3. S - SELECT: Load Context Just-In-Time, Not Just-In-Case

Frontier LLMs follow instructions best when they are concise. The "Select" strategy is about progressive disclosure—loading only the context necessary for the specific task at hand, rather than dumping the entire codebase into the context window.

**The 3-Tier Context System:**

| Tier | Description | Implementation |
| :--- | :--- | :--- |
| **Tier 1: Global Rules** | Always loaded. Covers essential project structure, architecture overview, and universal conventions. | `CLAUDE.md` (Keep under 500 lines. If removing a line wouldn't cause mistakes, cut it.) |
| **Tier 2: On-Demand Rules** | Loaded automatically based on the files the agent is touching. | `.claude/rules/*.md` (e.g., `testing.md` loads when touching `*.test.ts`; `database.md` loads when touching `**/db/**`). |
| **Tier 3: Reference Docs** | Heavy reference guides designed for sub-agent scouting. NOT auto-loaded. | `.claude/docs/*.md` (e.g., `architecture-deep-dive.md`, `api-reference.md`). |

**Focused Exploration (Prime Commands):**
Instead of a generic command that explores the entire codebase, use focused "prime" commands to orient the agent on a specific subsystem. For example, `/prime-frontend` loads only React UI, hooks, and components, while `/prime-backend` loads core business logic and the HTTP server.

### 4. C - COMPRESS: The Safety Net (Not the Strategy)

Compression should be a last resort, not a primary strategy. If you are effectively using Write, Isolate, and Select, you shouldn't need to compress often. The best compression strategy is not needing compression.

**Key Practices:**

*   **Proactive Strategies:** Aim for one feature per conversation. Clear the context between unrelated tasks. Use specifications as session checkpoints.
*   **Focused Compaction:** If a session must be compressed, use a focused compaction command (like Claude Code's built-in `/compact`) with explicit instructions to preserve critical information (e.g., "preserve titles, key decisions, and next steps").
*   **The Handoff:** If a session is running too long and context rot is setting in, the best approach is to write a `/handoff` document (Write) and start a completely fresh session.

---

## Implementing WISC with Claude Code Commands

The WISC framework can be operationalized using custom slash commands in Claude Code (stored in `.claude/commands/`). Here is how the strategies map to practical commands:

### Planning & Execution Commands (Write & Isolate)

*   `/plan-feature <feature-name>`: Spawns sub-agents to research the codebase (Isolate), synthesizes findings, and writes a detailed implementation plan to a file (Write). This plan includes success criteria, affected packages, architecture notes, and step-by-step tasks.
*   `/execute <plan-file>`: Reads a generated plan file and implements it step-by-step in a fresh session. It relies entirely on the written spec, avoiding the context bloat of the planning phase.

### Context Priming Commands (Select)

*   `/prime`: Provides a full codebase overview.
*   `/prime-backend`: Loads context specifically for backend logic and servers.
*   `/prime-frontend`: Loads context specifically for UI components and hooks.
*   *(These commands analyze project structure, read core documentation, identify key entry points, and summarize the current state for the specific domain).*

### Session Management Commands (Write & Compress)

*   `/handoff`: Analyzes the current session, gathers git state, and writes a structured `HANDOFF.md` file containing goals, completed tasks, in-progress items, key decisions, and dead ends. This allows a fresh session to continue seamlessly.
*   `/commit`: Creates an enriched commit with conventional tags, a WHY-focused body, and a context section logging changes to rules or documentation.

---

## Step-by-Step Guide to Applying WISC

To transform your AI coding workflow using the WISC framework, follow these steps:

1.  **Start with Write:** Implement enriched commits and spec-driven planning. Before coding, force the AI to write a `spec.md`. This single change drastically improves reliability.
2.  **Add Select:** Move domain-specific conventions out of your global `CLAUDE.md` and into path-scoped rule files (e.g., `.claude/rules/`). Keep your global rules lean and focused.
3.  **Use Isolate:** When researching a new feature or bug, use sub-agents or separate sessions. Do not pollute your main implementation session with exploration noise.
4.  **Compress as Needed:** Monitor your session length. When context rot begins (e.g., the AI starts repeating mistakes or ignoring instructions), use `/handoff` to write the state to disk and start fresh.

By treating context as an engineered product rather than a static prompt, the WISC framework enables AI coding assistants like Claude Code to operate reliably on complex, real-world projects.

---

## References

[1] Cole Medin. "Context engineering is the new vibe coding". GitHub Repository. https://github.com/coleam00/context-engineering-intro
[2] Cole Medin. "WISC Framework: Context Engineering for AI Coding". GitHub Repository. https://github.com/coleam00/context-engineering-intro/tree/main/use-cases/ai-coding-wisc-framework
[3] Cole Medin. "I've Used Claude Code for 2,000+ Hours - Here's How I Build Anything With It". YouTube Video. https://www.youtube.com/watch?v=nxHKBq5ZU9U