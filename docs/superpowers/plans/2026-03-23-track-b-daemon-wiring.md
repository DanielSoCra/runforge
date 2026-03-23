# Track B: Daemon Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip multi-repo complexity from the daemon, wire the coordination layer (PO agent, coordinator) into daemon startup, implement PO tools and prompt template, strip dashboard GitHub repo flow, and get the daemon running end-to-end with PO proposing work.

**Architecture:** Single-daemon-per-repo. The Coordinator's tick loop replaces the legacy polling loop. PO tools run as a local MCP server that the PO session connects to. Work detection functions become the Coordinator's dispatch queue. Dashboard becomes a read-only fleet aggregator.

**Tech Stack:** TypeScript, Vitest, Octokit, MCP SDK, Supabase (optional), Node.js

**Design spec:** `docs/superpowers/specs/2026-03-23-track-b-daemon-wiring-design.md`

---

### Task 1: Fix review-finding L0 boundary violation

**Files:**
- Modify: `packages/daemon/src/control-plane/work-detection.ts:48-76`
- Test: `packages/daemon/src/control-plane/work-detection.test.ts`

This must happen first — the current behavior violates L0 and our new L1 specs.

- [ ] **Step 1: Read the current test file**

Read `packages/daemon/src/control-plane/work-detection.test.ts` to understand existing test patterns for `detectBugFixWork`.

- [ ] **Step 2: Write failing test**

Add a test that verifies `review-finding` issues without `auto-fix-approved` label are excluded:

```typescript
it('excludes review-finding issues without auto-fix-approved label', async () => {
  mockOctokit.issues.listForRepo.mockResolvedValue({
    data: [
      { number: 1, labels: [{ name: 'review-finding' }, { name: 'P1' }], title: 'Finding only' },
    ],
  });
  const result = await detector.detectBugFixWork();
  expect(result.ok).toBe(true);
  expect(result.value).toBeNull();
});

it('includes review-finding issues with auto-fix-approved label', async () => {
  mockOctokit.issues.listForRepo.mockResolvedValue({
    data: [
      { number: 2, labels: [{ name: 'review-finding' }, { name: 'auto-fix-approved' }, { name: 'P1' }], title: 'Approved fix' },
    ],
  });
  const result = await detector.detectBugFixWork();
  expect(result.ok).toBe(true);
  expect(result.value).not.toBeNull();
  expect(result.value?.issueNumber).toBe(2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/daemon/src/control-plane/work-detection.test.ts -t "review-finding"`
Expected: FAIL — current code returns the issue regardless of auto-fix-approved

- [ ] **Step 4: Fix detectBugFixWork**

In `work-detection.ts`, around line 55 where issues are filtered, add a filter that requires `auto-fix-approved` label:

```typescript
const eligible = issues.filter(issue => {
  const labels = issue.labels.map(l => typeof l === 'string' ? l : l.name);
  const hasAutoFixApproved = labels.includes('auto-fix-approved');
  if (!hasAutoFixApproved) return false;
  // existing filters for in-progress, blocked...
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/daemon/src/control-plane/work-detection.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/control-plane/work-detection.ts packages/daemon/src/control-plane/work-detection.test.ts
git commit -m "fix(work-detection): require auto-fix-approved for review-finding dispatch (L0 boundary)"
```

---

### Task 2: Add 'po' SessionType and AgentDefinition

**Files:**
- Modify: `packages/daemon/src/types.ts:21-25`
- Modify: `packages/daemon/src/session-runtime/runtime.ts:54-136`
- Create: `prompts/po.md`

- [ ] **Step 1: Add 'po' to SessionType union**

In `packages/daemon/src/types.ts`, add `'po'` to the union:

```typescript
export type SessionType =
  | 'coordinator' | 'classifier' | 'worker'
  | 'reviewer-spec' | 'reviewer-quality' | 'reviewer-security'
  | 'bug-worker' | 'diagnostician'
  | 'codebase-reviewer'
  | 'po';
```

- [ ] **Step 2: Check for exhaustiveness breakage**

Run: `npx tsc --noEmit 2>&1 | grep -i "not assignable\|exhaustive\|switch"`
Fix any TypeScript errors where switch statements on SessionType need a new case.

- [ ] **Step 3: Add PO AgentDefinition**

In `packages/daemon/src/session-runtime/runtime.ts`, add to `DEFAULT_AGENT_DEFS`:

The actual `AgentDefinition` type (types.ts:31-40) requires: `name`, `description`, `systemPrompt`, `allowedTools`, `maxTurns`, `timeoutMs`, `budgetCap`. **Use the real shape:**

```typescript
po: {
  name: 'po',
  description: 'Product Owner — proposes highest-value next work',
  systemPrompt: '',  // populated from prompts/po.md by assemblePrompt()
  allowedTools: [],
  maxTurns: 20,
  timeoutMs: 300_000,
  budgetCap: 0.50,
},
```

Note: design spec used `promptFile`/`budgetPerSession` — those don't exist on `AgentDefinition`.

- [ ] **Step 4: Create PO prompt template**

Create `prompts/po.md`:

```markdown
# Product Owner Agent

You are the Product Owner agent for {{repoName}}. Your job is to analyze the current state of the project and propose the next most valuable work.

## Your Tools

- `scan_spec_pipeline` — reads the specification directory and returns which specs exist at each layer, their status, and where gaps are
- `get_backlog` — queries open issues and returns them with age, staleness, and labels
- `create_proposal` — creates a new proposal with title, rationale, and optional spec references
- `list_proposals` — lists existing proposals filtered by status

## Your Process

1. Call `list_proposals` to see what has already been proposed, approved, or rejected recently. Do not re-propose work that was rejected without new justification.
2. Call `scan_spec_pipeline` to identify specification gaps — L1 specs without L2, L2 without L3, L3 not yet implemented.
3. Call `get_backlog` to find stale issues (in-progress with no activity), ready work that needs prioritization, and aging items.
4. Analyze the signals together. Prioritize:
   - Spec advancement (unblocks the pipeline) — highest value
   - Stale work escalation (prevents waste)
   - Backlog prioritization (keeps work flowing)
5. For each proposal, call `create_proposal` with a clear title, rationale explaining why this is the highest-value next step, and spec references where applicable.
6. Generate at most {{maxProposals}} proposals per cycle. Quality over quantity.

## Constraints

- Never propose implementation details — that is the Tech Lead's domain
- Never create work directly — only propose. The operator approves.
- If the pipeline is healthy and the backlog is clean, propose nothing. Silence is a valid output.

{{#if pendingIdeas}}
## Operator Ideas to Refine

The operator has submitted these ideas. Evaluate each and refine into a scoped proposal if worthwhile:

{{pendingIdeas}}
{{/if}}
```

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/types.ts packages/daemon/src/session-runtime/runtime.ts prompts/po.md
git commit -m "feat: add 'po' session type, agent definition, and prompt template"
```

---

### Task 3: Implement PO tools

**Files:**
- Create: `packages/daemon/src/coordination/po-tools.ts`
- Create: `packages/daemon/src/coordination/po-tools.test.ts`

- [ ] **Step 1: Write tests for scan_spec_pipeline**

Create `packages/daemon/src/coordination/po-tools.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createScanSpecPipeline } from './po-tools.js';

describe('scan_spec_pipeline', () => {
  it('identifies specs with missing next layer', async () => {
    const scan = createScanSpecPipeline('/fake/repo');
    // Mock fs to return a .specify/ structure with gaps
    // Test that result includes specs with hasNextLayer: false
  });
});
```

Read `traceability.yml` format and existing `.specify/` structure to write realistic test fixtures.

- [ ] **Step 2: Write tests for get_backlog**

```typescript
describe('get_backlog', () => {
  it('excludes in-progress and blocked issues', async () => {
    const mockOctokit = { issues: { listForRepo: vi.fn() } };
    mockOctokit.issues.listForRepo.mockResolvedValue({
      data: [
        { number: 1, title: 'Ready', labels: [{ name: 'ready' }], created_at: '2026-03-01', updated_at: '2026-03-20' },
        { number: 2, title: 'Blocked', labels: [{ name: 'blocked' }], created_at: '2026-03-01', updated_at: '2026-03-20' },
        { number: 3, title: 'Finding', labels: [{ name: 'review-finding' }], created_at: '2026-03-01', updated_at: '2026-03-20' },
      ],
    });
    const backlog = createGetBacklog(mockOctokit, 'owner', 'repo');
    const result = await backlog();
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });
});
```

- [ ] **Step 3: Write tests for create_proposal**

```typescript
describe('create_proposal', () => {
  it('creates proposal with correct status and expiry', async () => {
    const mockStore = { load: vi.fn().mockResolvedValue([]), save: vi.fn() };
    const create = createCreateProposal(mockStore, { expiryDays: 7 });
    const result = await create({ title: 'Test', rationale: 'Because' });
    expect(result.status).toBe('proposed');
    expect(result.id).toBeDefined();
    expect(mockStore.save).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ title: 'Test' })]));
  });

  it('rejects duplicate titles within 24 hours', async () => {
    const existing = [{ title: 'Test', status: 'proposed', createdAt: new Date().toISOString() }];
    const mockStore = { load: vi.fn().mockResolvedValue(existing), save: vi.fn() };
    const create = createCreateProposal(mockStore, { expiryDays: 7 });
    await expect(create({ title: 'Test', rationale: 'Again' })).rejects.toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run packages/daemon/src/coordination/po-tools.test.ts`
Expected: FAIL — functions don't exist yet

- [ ] **Step 5: Implement po-tools.ts**

Create `packages/daemon/src/coordination/po-tools.ts` with factory functions:

```typescript
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Proposal } from './types.js';
import { v4 as uuid } from 'uuid';

export interface ProposalStore {
  load(): Promise<Proposal[]>;
  save(proposals: Proposal[]): Promise<void>;
}

export interface SpecPipelineEntry {
  specId: string;
  layer: number;
  status: string;
  hasNextLayer: boolean;
  implemented: boolean;
}

export function createScanSpecPipeline(repoRoot: string) {
  return async function scanSpecPipeline(): Promise<SpecPipelineEntry[]> {
    const traceabilityPath = join(repoRoot, '.specify', 'traceability.yml');
    const raw = await readFile(traceabilityPath, 'utf-8');
    const traceability = parseYaml(raw);

    const entries: SpecPipelineEntry[] = [];
    for (const [specId, spec] of Object.entries(traceability)) {
      if (typeof spec !== 'object' || !spec) continue;
      const s = spec as Record<string, unknown>;
      const children = (s.children as string[]) || [];
      const codePaths = (s.code_paths as string[]) || [];
      const layer = specId.startsWith('L0') ? 0
        : specId.startsWith('FUNC') ? 1
        : specId.startsWith('ARCH') ? 2
        : specId.startsWith('STACK') ? 3 : -1;

      entries.push({
        specId,
        layer,
        status: (s.status as string) || 'unknown',
        hasNextLayer: children.length > 0,
        implemented: codePaths.length > 0,
      });
    }
    return entries;
  };
}

export function createGetBacklog(octokit: any, owner: string, repo: string) {
  return async function getBacklog(): Promise<Array<{ number: number; title: string; labels: string[]; ageDays: number; stalenessDays: number }>> {
    const { data } = await octokit.issues.listForRepo({
      owner, repo, state: 'open', per_page: 100,
    });
    const now = Date.now();
    const excludeLabels = ['in-progress', 'blocked', 'review-finding'];

    return data
      .filter((issue: any) => {
        const labels = issue.labels.map((l: any) => typeof l === 'string' ? l : l.name);
        return !labels.some((l: string) => excludeLabels.includes(l));
      })
      .filter((issue: any) => !issue.pull_request)
      .map((issue: any) => ({
        number: issue.number,
        title: issue.title,
        labels: issue.labels.map((l: any) => typeof l === 'string' ? l : l.name),
        ageDays: Math.floor((now - new Date(issue.created_at).getTime()) / 86400000),
        stalenessDays: Math.floor((now - new Date(issue.updated_at).getTime()) / 86400000),
      }));
  };
}

export function createCreateProposal(store: ProposalStore, config: { expiryDays: number }, supabaseSync?: (p: Proposal) => Promise<void>) {
  return async function createProposal(input: { title: string; rationale: string; relatedSpecs?: string[]; scope?: string }): Promise<Proposal> {
    const existing = await store.load();

    // Deduplication: reject duplicates within 24 hours
    const dayAgo = Date.now() - 86400000;
    const duplicate = existing.find(p => p.title === input.title && new Date(p.createdAt).getTime() > dayAgo);
    if (duplicate) throw new Error(`Duplicate proposal: "${input.title}" was proposed within the last 24 hours`);

    // Actual Proposal Zod schema (coordination/types.ts:9-23) requires all fields
    const proposal: Proposal = {
      id: uuid(),
      title: input.title,
      rationale: input.rationale,
      relatedSpecs: input.relatedSpecs || [],
      relatedIssues: [],
      scope: (input.scope as 'small' | 'medium' | 'large') || 'medium',
      status: 'proposed',
      issueNumber: null,
      approvedBy: null,
      decisionNotes: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + config.expiryDays * 86400000).toISOString(),
    };

    await store.save([...existing, proposal]);
    if (supabaseSync) await supabaseSync(proposal);
    return proposal;
  };
}

export function createListProposals(store: ProposalStore) {
  return async function listProposals(statusFilter?: string): Promise<Proposal[]> {
    const proposals = await store.load();
    if (statusFilter) return proposals.filter(p => p.status === statusFilter);
    return proposals;
  };
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/daemon/src/coordination/po-tools.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/coordination/po-tools.ts packages/daemon/src/coordination/po-tools.test.ts
git commit -m "feat(coordination): implement PO tools — scan pipeline, get backlog, create/list proposals"
```

---

### Task 4: Implement local MCP server for PO tools

**Files:**
- Create: `packages/daemon/src/coordination/po-mcp-server.ts`
- Create: `packages/daemon/src/coordination/po-mcp-server.test.ts`

- [ ] **Step 1: Read existing MCP patterns**

Read `packages/daemon/src/coordination/terminal-server.ts` for the MCP server pattern used in this codebase. Note the imports, tool registration, and transport setup.

- [ ] **Step 2: Write test**

```typescript
describe('PO MCP Server', () => {
  it('starts and stops cleanly', async () => {
    const server = createPOMcpServer(mockTools);
    const { port } = await server.start();
    expect(port).toBeGreaterThan(0);
    await server.stop();
  });

  it('exposes all four PO tools', async () => {
    const server = createPOMcpServer(mockTools);
    const { port } = await server.start();
    // Connect as client, list tools, verify 4 tools registered
    await server.stop();
  });
});
```

- [ ] **Step 3: Implement po-mcp-server.ts**

Create a lightweight MCP server that:
- Listens on a random available port (or Unix socket)
- Registers the 4 PO tools (scan_spec_pipeline, get_backlog, create_proposal, list_proposals)
- Returns the connection config (URL/port) for the session to connect to
- Has `start()` and `stop()` methods

Follow the pattern from `terminal-server.ts` but use SSE or streamable HTTP transport instead of stdio (since this runs in-process).

```typescript
import { McpServer } from '@anthropic-ai/sdk/mcp';
// or whatever MCP server library the project uses — read terminal-server.ts imports

export interface POMcpServerDeps {
  scanSpecPipeline: () => Promise<any>;
  getBacklog: () => Promise<any>;
  createProposal: (input: any) => Promise<any>;
  listProposals: (statusFilter?: string) => Promise<any>;
}

export function createPOMcpServer(deps: POMcpServerDeps) {
  // Register tools, start server on random port
  // Return { start(): Promise<{ port: number }>, stop(): Promise<void> }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/daemon/src/coordination/po-mcp-server.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/coordination/po-mcp-server.ts packages/daemon/src/coordination/po-mcp-server.test.ts
git commit -m "feat(coordination): local MCP server for PO tools"
```

---

### Task 5: Add POAgent.runCycle to public interface

**Files:**
- Modify: `packages/daemon/src/coordination/po-agent.ts:18-21`
- Modify: `packages/daemon/src/coordination/po-agent.test.ts`

- [ ] **Step 1: Read existing POAgent test**

Read `packages/daemon/src/coordination/po-agent.test.ts` to understand test patterns.

- [ ] **Step 2: Write test for runCycle**

```typescript
it('exposes runCycle for manual triggering', async () => {
  const agent = createPOAgent(deps, config);
  // runCycle should call spawnPOSession
  await agent.runCycle();
  expect(deps.spawnPOSession).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: Add runCycle to POAgent interface**

In `po-agent.ts`, update the interface:

```typescript
export interface POAgent {
  start(): () => void;
  submitIdea(submittedBy: string, description: string): Promise<IdeaSubmission>;
  runCycle(): Promise<void>;
}
```

And expose `runCycle` in the return object of `createPOAgent`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/daemon/src/coordination/po-agent.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/coordination/po-agent.ts packages/daemon/src/coordination/po-agent.test.ts
git commit -m "feat(po-agent): expose runCycle for manual triggering"
```

---

### Task 6: Add proposal REST endpoints to control server

**Files:**
- Modify: `packages/daemon/src/control-plane/server.ts:6-15` (ControlHandlers) and `:35-102` (routes)
- Modify: `packages/daemon/src/control-plane/server.test.ts`

- [ ] **Step 1: Read existing server tests**

Read `packages/daemon/src/control-plane/server.test.ts` for the test pattern.

- [ ] **Step 2: Write tests for new endpoints**

```typescript
describe('proposal endpoints', () => {
  it('GET /proposals returns proposal list', async () => { /* ... */ });
  it('POST /proposals/:id/approve creates GitHub issue and updates status', async () => { /* ... */ });
  it('POST /proposals/:id/reject updates status with notes', async () => { /* ... */ });
  it('POST /po/trigger calls runCycle', async () => { /* ... */ });
});
```

- [ ] **Step 3: Add handlers to ControlHandlers interface**

```typescript
export interface ControlHandlers {
  // ... existing
  listProposals?: () => Promise<unknown>;
  approveProposal?: (id: string, notes?: string) => Promise<unknown>;
  rejectProposal?: (id: string, notes?: string) => Promise<unknown>;
  triggerPOCycle?: () => Promise<void>;
}
```

- [ ] **Step 4: Add routes**

Add before the final `else` clause in the routing:

```typescript
if (method === 'GET' && pathname === '/proposals') {
  const proposals = await handlers.listProposals?.();
  respond(res, 200, proposals);
} else if (method === 'POST' && pathname.match(/^\/proposals\/(.+)\/approve$/)) {
  const id = pathname.match(/^\/proposals\/(.+)\/approve$/)?.[1];
  const body = await parseBody(req);
  const result = await handlers.approveProposal?.(id!, body?.notes);
  respond(res, 200, result);
} else if (method === 'POST' && pathname.match(/^\/proposals\/(.+)\/reject$/)) {
  const id = pathname.match(/^\/proposals\/(.+)\/reject$/)?.[1];
  const body = await parseBody(req);
  const result = await handlers.rejectProposal?.(id!, body?.notes);
  respond(res, 200, result);
} else if (method === 'POST' && pathname === '/po/trigger') {
  await handlers.triggerPOCycle?.();
  respond(res, 200, { triggered: true });
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/daemon/src/control-plane/server.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/control-plane/server.ts packages/daemon/src/control-plane/server.test.ts
git commit -m "feat(server): add proposal and PO trigger REST endpoints"
```

---

### Task 7: Strip multi-repo from daemon and wire coordination

This is the big task — daemon.ts surgery. Read the design spec Section 1 and Section 4 (Coordinator Wiring) before starting.

**Files:**
- Modify: `packages/daemon/src/control-plane/daemon.ts` (major rewrite)
- Modify: `packages/daemon/src/config.ts` (simplify config)

- [ ] **Step 1: Read daemon.ts, config.ts, and the design spec fully**

Read all three files completely. Understand every line of the startup sequence before touching anything.

- [ ] **Step 2: Simplify config**

The `coordination` section already exists in `config.ts` (lines 105-133) with fields: `maxAgents`, `reviewerInterval`, `poInterval`, `plannerTimeout`, `maxAttemptsPerIssue`, `diskSpaceThreshold` (bytes), `gcInterval`, conflict/merge thresholds. **Do NOT create a new section.** Add these new fields to the existing schema:

```typescript
// Add to existing coordination z.object():
poDebounceMs: z.number().int().min(10000).default(300000),       // 5 minutes
poMaxProposals: z.number().int().min(1).default(3),
proposalExpiryDays: z.number().int().min(1).default(7),
tickIntervalMs: z.number().int().min(10000).default(30000),
```

Use existing `poInterval` for PO cycle interval. Use existing `maxAgents` and `diskSpaceThreshold` for coordinator config.

- [ ] **Step 3: Remove RepoManager and DB-mode branching**

In `daemon.ts`:
- Remove `RepoManager` import and instantiation
- Remove the `if (supabaseLayer)` branch that creates RepoManager (around lines 145-250)
- Remove the legacy polling loop (around lines 355-410)
- Remove `repoManager` from shutdown sequence
- Remove `legacyPoller` interval
- Remove `reloadRepos` and `scanIssues` from control server handler wiring (daemon.ts:273-279) — these reference `repoManager` which no longer exists

- [ ] **Step 4: Wire coordination components**

After service initialization (around line 66), add:

```typescript
// Coordination layer
const stateDir = config.stateDir || './state';
const coordDir = join(stateDir, 'coordination');
await mkdir(coordDir, { recursive: true });

const workClaimer = createWorkClaimer(coordDir);
const batchManager = createBatchManager(coordDir);
const mergeAgent = createMergeAgent(/* deps */);

// Work request cache for getDispatchQueue → spawnWorker bridge
const workRequestCache = new Map<number, WorkRequest>();

const coordinator = createCoordinator({
  workClaimer,
  batchManager,
  mergeAgent,
  spawnWorker: async (claim, decision) => {
    const wr = workRequestCache.get(claim.issueNumber);
    if (wr) {
      await detector.claimWork(claim.issueNumber); // GitHub labels
    }
    await processWorkRequest(config, /* ... */, wr!, runtime, /* ... */);
  },
  checkDiskSpace: async () => { /* use existing disk check */ return true; },
  getDispatchQueue: async () => {
    const items = [];
    const ready = await detector.detectReadyWork();
    const bugFix = await detector.detectBugFixWork();
    const feature = await detector.detectFeaturePipelineWork();
    for (const wr of [...(ready.ok ? ready.value : []), ...(bugFix.ok && bugFix.value ? [bugFix.value] : []), ...(feature.ok && feature.value ? [feature.value] : [])]) {
      workRequestCache.set(wr.issueNumber, wr);
      items.push({ issueNumber: wr.issueNumber, repoKey: `${config.repo}` });
    }
    return items;
  },
  getActiveClaimRepoKeys: async () => new Map(),
  isPaused: () => paused || remoteControl.isPaused(),
  isShuttingDown: () => shuttingDown,
  onMergeAgentCrash: (cb) => { /* register */ },
}, {
  tickIntervalMs: config.coordination.tickIntervalMs ?? 30000,
  maxAgents: config.coordination.maxAgents,
  perRepoLimits: {},  // kept for backward compat, empty in single-repo mode
  diskSpaceThreshold: config.coordination.diskSpaceThreshold,  // bytes, not MB
});
```

- [ ] **Step 5: Wire PO Agent**

```typescript
const proposalStore = createJsonStore<Proposal[]>(join(coordDir, 'proposals.json'), []);
const ideaStore = createJsonStore<IdeaSubmission[]>(join(coordDir, 'ideas.json'), []);

// PO tools
const scanSpecPipeline = createScanSpecPipeline(repoRoot);
const getBacklog = createGetBacklog(octokit, owner, repoName);
const createProposalTool = createCreateProposal(proposalStore, { expiryDays: config.coordination.proposalExpiryDays ?? 7 });
const listProposalsTool = createListProposals(proposalStore);

// PO MCP server
const poMcpServer = createPOMcpServer({
  scanSpecPipeline, getBacklog,
  createProposal: createProposalTool,
  listProposals: listProposalsTool,
});

const poAgent = createPOAgent({
  loadProposals: proposalStore.load,
  saveProposals: proposalStore.save,
  loadIdeas: ideaStore.load,
  saveIdeas: ideaStore.save,
  spawnPOSession: async () => {
    const ideas = await ideaStore.load();
    const { port } = await poMcpServer.start();
    try {
      // SessionContext (types.ts:42-47) does NOT have mcpConfigs.
      // MCP configs come from plugin injection via assemblePrompt().
      // Option: add mcpConfigs to SessionContext type, then pass through
      // to adapter in runtime.ts:194. This is a small type extension.
      // Alternatively, register the PO MCP server as a synthetic plugin.
      //
      // Simplest path: extend SessionContext with optional mcpConfigs:
      //   mcpConfigs?: Array<{ url: string }>;
      // Then in runtime.ts assemblePrompt(), merge context.mcpConfigs
      // with plugin mcpConfigs before passing to adapter.
      await runtime.spawnSession('po', {
        variables: {
          repoName: config.repo,
          maxProposals: String(config.coordination.poMaxProposals ?? 3),
          pendingIdeas: JSON.stringify(ideas),
        },
        mcpConfigs: [{ url: `http://localhost:${port}` }],
      }, 0);
    } finally {
      await poMcpServer.stop();
    }
  },
}, {
  intervalMs: config.coordination.poInterval,           // existing field, default 3600000
  debounceMs: config.coordination.poDebounceMs ?? 300000, // new field
});
```

- [ ] **Step 6: Start coordination and wire control handlers**

```typescript
const stopCoordinator = coordinator.start();
const stopPO = poAgent.start();

// Wire proposal handlers to control server
handlers.listProposals = listProposalsTool;
handlers.approveProposal = async (id, notes) => {
  const proposals = await proposalStore.load();
  const proposal = proposals.find(p => p.id === id);
  if (!proposal) throw new Error(`Proposal ${id} not found`);
  proposal.status = 'approved';
  proposal.decidedAt = new Date().toISOString();
  proposal.decisionNotes = notes;
  await proposalStore.save(proposals);
  // Create GitHub issue with ready label (atomic)
  const { data: issue } = await octokit.issues.create({
    owner, repo: repoName,
    title: proposal.title,
    body: `## Proposal\n\n${proposal.rationale}\n\n**Specs:** ${proposal.relatedSpecs?.join(', ') || 'none'}`,
    labels: ['ready'],
  });
  return { issueNumber: issue.number, proposalId: id };
};
handlers.rejectProposal = async (id, notes) => {
  const proposals = await proposalStore.load();
  const proposal = proposals.find(p => p.id === id);
  if (!proposal) throw new Error(`Proposal ${id} not found`);
  proposal.status = 'rejected';
  proposal.decidedAt = new Date().toISOString();
  proposal.decisionNotes = notes;
  await proposalStore.save(proposals);
  return { proposalId: id, status: 'rejected' };
};
handlers.triggerPOCycle = () => poAgent.runCycle();
```

- [ ] **Step 7: Update shutdown sequence**

```typescript
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down...');
  stopCoordinator();
  stopPO();
  stopReviewScheduler();
  // ... wait for active runs, stop server
};
```

- [ ] **Step 8: Run all daemon tests**

Run: `npx vitest run packages/daemon/src/control-plane/`
Fix any failures.

- [ ] **Step 9: Commit**

```bash
git add packages/daemon/src/control-plane/daemon.ts packages/daemon/src/config.ts
git commit -m "feat(daemon): strip multi-repo, wire coordinator and PO agent"
```

---

### Task 8: Supabase migration for daemons and proposals tables

**Files:**
- Create: `supabase/migrations/011_daemons_and_proposals.sql`

- [ ] **Step 1: Write migration**

```sql
-- Daemons table (fleet registration)
CREATE TABLE IF NOT EXISTS public.daemons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'starting',
  last_heartbeat timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(repo_owner, repo_name)
);

ALTER TABLE public.daemons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read daemons"
  ON public.daemons FOR SELECT
  TO authenticated
  USING (true);

-- Proposals table
CREATE TABLE IF NOT EXISTS public.proposals (
  id uuid PRIMARY KEY,
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  title text NOT NULL,
  rationale text NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  related_specs text[] DEFAULT '{}',
  scope text DEFAULT 'medium',
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  decided_at timestamptz,
  decision_notes text
);

ALTER TABLE public.proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read proposals"
  ON public.proposals FOR SELECT
  TO authenticated
  USING (true);

-- Enable realtime for proposals
ALTER PUBLICATION supabase_realtime ADD TABLE public.proposals;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/011_daemons_and_proposals.sql
git commit -m "feat(supabase): add daemons and proposals tables"
```

---

### Task 9: Strip dashboard GitHub repo flow

**Files:**
- Delete: `packages/dashboard/app/api/github/connections/` (entire directory)
- Delete: `packages/dashboard/app/(dashboard)/command-center/` (entire directory)
- Delete: `packages/dashboard/actions/github-connections.ts`
- Delete: `packages/dashboard/components/github-connections-section.tsx`
- Modify: `packages/dashboard/components/sidebar.tsx` (remove command center link)

This task is fully independent from daemon work.

- [ ] **Step 1: Read sidebar.tsx to find the link**

Read `packages/dashboard/components/sidebar.tsx` and find the command center navigation entry.

- [ ] **Step 2: Remove the command center sidebar link**

Remove the `{ href: '/command-center', ...}` entry from the navigation array.

- [ ] **Step 3: Delete the files**

```bash
rm -rf packages/dashboard/app/api/github/connections/
rm -rf packages/dashboard/app/\(dashboard\)/command-center/
rm -f packages/dashboard/actions/github-connections.ts
rm -f packages/dashboard/components/github-connections-section.tsx
```

- [ ] **Step 4: Check for broken imports**

```bash
npx tsc --noEmit -p packages/dashboard/tsconfig.json 2>&1 | head -30
```

Fix any imports that reference deleted files.

- [ ] **Step 5: Commit**

```bash
git add -A packages/dashboard/
git commit -m "feat(dashboard): strip GitHub repo connection flow and command center"
```

---

### Task 10: Add fleet status page and proposals to briefing

**Files:**
- Create: `packages/dashboard/app/(dashboard)/fleet/page.tsx`
- Modify: `packages/dashboard/app/(dashboard)/briefing/page.tsx`
- Modify: `packages/dashboard/components/sidebar.tsx` (add fleet link replacing removed command center)

- [ ] **Step 1: Read the briefing page**

Read `packages/dashboard/app/(dashboard)/briefing/page.tsx` to understand the existing structure.

- [ ] **Step 2: Create fleet status page**

Create `packages/dashboard/app/(dashboard)/fleet/page.tsx` that:
- Reads from `daemons` table via Supabase
- Shows each daemon: repo, status, last heartbeat (with "unresponsive" if >5 min old)
- Shows pending proposal count per daemon
- Read-only — no CRUD

- [ ] **Step 3: Add fleet link to sidebar**

Replace the removed command center link with: `{ href: '/fleet', label: 'Fleet', icon: Server }`

- [ ] **Step 4: Add proposals section to briefing page**

In the briefing page, add a "Pending Proposals" section that:
- Reads from `proposals` table filtered by `status = 'proposed'`
- Shows title, rationale, spec references, created date, expiry
- Has Approve and Reject buttons that call the daemon REST API (`POST /proposals/:id/approve` or `/reject`)
- The daemon URL comes from the `daemons` table entry for this repo

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/
git commit -m "feat(dashboard): add fleet status page and proposals to briefing"
```

---

### Task 11: Daemon self-registration in Supabase

**Files:**
- Modify: `packages/daemon/src/control-plane/daemon.ts` (add registration on startup, heartbeat, clean shutdown)

- [ ] **Step 1: Write self-registration function**

After Supabase layer init, if Supabase is configured:
- Upsert into `daemons` table with repo_owner, repo_name, url (from `config.controlPort`), status: 'running'
- Start a 60-second interval for heartbeat updates (`last_heartbeat = now()`)
- On shutdown, set status to 'stopped'

- [ ] **Step 2: Wire into startup and shutdown**

- Call registration after control server starts (step 7 in startup)
- Clear heartbeat interval in shutdown function
- Set status to 'stopped' in shutdown

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/control-plane/daemon.ts
git commit -m "feat(daemon): self-register in Supabase for fleet status"
```

---

### Task 12: End-to-end smoke test

**Depends on:** All previous tasks complete.

This is manual — you + the operator.

- [ ] **Step 1: Build the daemon**

```bash
npm run build
```

- [ ] **Step 2: Create test config**

Create a config file pointing at the auto-claude repo with coordination enabled.

- [ ] **Step 3: Start the daemon**

```bash
node packages/daemon/dist/index.js --config ./test-config.yml
```

Verify: clean boot, coordinator tick logged, PO cycle scheduled.

- [ ] **Step 4: Trigger PO cycle**

```bash
curl -X POST http://localhost:3100/po/trigger
```

Watch logs for PO session: tool calls to scan_spec_pipeline, get_backlog, list_proposals, create_proposal.

- [ ] **Step 5: Check proposals**

```bash
curl http://localhost:3100/proposals
```

Verify 1-3 proposals returned.

- [ ] **Step 6: Approve a proposal**

```bash
curl -X POST http://localhost:3100/proposals/{id}/approve
```

Verify: GitHub issue created with `ready` label.

- [ ] **Step 7: Watch next coordinator tick**

The new `ready` issue should be detected, claimed, and dispatched to a worker.
