// P5 release-lane IMMOVABLE acceptance gate — pure (no-DB) criteria 1–20.
//
// Authored RED against HEAD: the release lane (schema union, proposal, builder,
// executor, manager, resolve-consumer) is not implemented yet. Every not-yet-
// existing symbol is reached through a runtime dynamic `import()` with the
// specifier widened to `string` so tsc never resolves it (no TS2307, and no
// suppression directives) and vitest can COLLECT the file; the missing export is then
// converted to a clean failing assertion inside each async test — never a
// collection/transform crash. The suite goes GREEN only when Tasks 1–5 land.
//
// Source of truth: docs/superpowers/plans/2026-07-03-p5-release-lane.md
// §"Immovable Acceptance-Gate Spec" (criteria 1–20). L2 ARCH-AC-RELEASE, L3
// STACK-AC-RELEASE.

import { describe, it, expect, vi } from 'vitest';
import {
  DecisionRequestSchema,
  type DecisionRequest,
} from '@runforge/decision-protocol';

const NOW = '2026-07-03T00:00:00.000Z';

// --------------------------------------------------------------------------
// Runtime-lookup loaders. `modulePath: string` (widened) keeps tsc from
// resolving a not-yet-existing specifier; a missing module/symbol becomes a
// clean per-test assertion failure (the RED reason), not a collection error.
// --------------------------------------------------------------------------

async function loadExport<T>(modulePath: string, name: string): Promise<T> {
  let record: Record<string, unknown> = {};
  try {
    record = (await import(modulePath)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `gate: module ${modulePath} must exist and export ${name} — ${(err as Error).message}`,
    );
  }
  const exported = record[name];
  expect(
    exported,
    `gate: ${name} must be exported by ${modulePath}`,
  ).toBeTypeOf('function');
  return exported as T;
}

async function loadSafeParse(
  modulePath: string,
  name: string,
): Promise<(v: unknown) => { success: boolean }> {
  let record: Record<string, unknown> = {};
  try {
    record = (await import(modulePath)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`gate: module ${modulePath} must exist — ${(err as Error).message}`);
  }
  const schema = record[name] as
    | { safeParse?: (v: unknown) => { success: boolean } }
    | undefined;
  expect(schema, `gate: ${name} must be exported by ${modulePath}`).toBeTypeOf('object');
  expect(schema?.safeParse, `gate: ${name}.safeParse`).toBeTypeOf('function');
  return (v: unknown) =>
    (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(v);
}

// --------------------------------------------------------------------------
// Loaded-symbol signatures (precise enough that the calls typecheck).
// --------------------------------------------------------------------------

type Repo = { owner: string; name: string };
type ReleaseOutcome =
  | 'released'
  | 'triggered-awaiting'
  | 'recorded-awaiting-human'
  | 'failed';

interface ReleaseProposalLike {
  deployment: string;
  targetRevision: string;
  sinceRevision: string | undefined;
  coveredWork: { sha: string; subject: string; issueNumbers: number[] }[];
  declaredPath: unknown;
  summary: string;
}

type BuildReleaseDecisionRequest = (
  proposal: ReleaseProposalLike,
  opts?: { now?: string; expiresAt?: string; sourceUrl?: string },
) => DecisionRequest;
type ReleaseDecisionId = (deployment: string, targetRevision: string) => string;

interface AssemblePreview {
  kind: string;
  proposal?: ReleaseProposalLike;
  reason?: string;
}
type AssembleReleaseProposal = (args: {
  deployment: string;
  registry: {
    readDeclaredData: (
      id: string,
      which: 'landing',
    ) => { kind: 'found'; value: unknown } | { kind: 'not-found' };
  };
  repositories: Repo[];
  ledgerReader: { lastReleasedMarker: (deployment: string) => Promise<string | undefined> };
  trunkReader: TrunkReaderLike;
}) => Promise<AssemblePreview>;

interface TrunkReaderLike {
  getTrunkHead: (owner: string, repo: string, branch: string) => Promise<{ sha: string }>;
  compareSince: (
    owner: string,
    repo: string,
    base: string,
    head: string,
  ) => Promise<{ commits: unknown[] }>;
  listRecent: (owner: string, repo: string, head: string) => Promise<{ commits: unknown[] }>;
}

interface ProposeResult {
  kind: string;
  decisionId?: string;
  reason?: string;
}
interface ResolveResult {
  kind: string;
  outcome?: ReleaseOutcome;
  reason?: string;
}
interface ReleaseLane {
  previewRelease: (deployment: string) => Promise<AssemblePreview>;
  proposeRelease: (deployment: string) => Promise<ProposeResult>;
  resolveRelease: (deployment: string, decisionId: string) => Promise<ResolveResult>;
  recordCompletion: (
    deployment: string,
    releaseId: string,
    outcome: 'released' | 'failed',
  ) => Promise<'applied' | 'already-terminal'>;
}
type CreateReleaseLane = (deps: unknown) => ReleaseLane;

type ReleaseLedgerManagerCtor = new (opts: {
  enabled: boolean;
  databaseUrl?: string;
  opener?: () => Promise<unknown>;
}) => {
  init: () => Promise<void>;
  isAvailable: () => boolean;
  ledger: () => unknown;
};

type ResolveAnsweredReleases = (deps: {
  lane: Pick<ReleaseLane, 'resolveRelease'>;
  reader: {
    openReleases: () => Promise<
      { deployment: string; releaseId: string; detail: Record<string, unknown> }[]
    >;
  };
}) => Promise<void>;

// --------------------------------------------------------------------------
// In-memory fake Release Ledger (writer + reader over one event array).
// Exposes `events` + `seed` so crash-recovery states can be pre-staged, and
// `setFailMode('append')` to model an unavailable store (writes throw).
// --------------------------------------------------------------------------

interface FakeRow {
  id: number;
  releaseId: string;
  deployment: string;
  event: 'proposal' | 'decision' | 'attempt' | 'execution' | 'completion' | 'resolved';
  targetRevision: string | null;
  detail: Record<string, unknown>;
  at: string;
}

function makeFakeLedger() {
  const events: FakeRow[] = [];
  let nextId = 1;
  let failMode: 'none' | 'append' = 'none';

  const seed = (e: Partial<FakeRow> & Pick<FakeRow, 'releaseId' | 'deployment' | 'event'>): void => {
    events.push({
      id: nextId++,
      at: NOW,
      targetRevision: null,
      detail: {},
      ...e,
    });
  };

  const reader = {
    eventsForRelease: vi.fn(async (deployment: string, releaseId: string) =>
      events
        .filter((r) => r.deployment === deployment && r.releaseId === releaseId)
        .sort((a, b) => a.id - b.id),
    ),
    lastReleasedMarker: vi.fn(async (deployment: string) => {
      const rows = events
        .filter(
          (r) =>
            r.deployment === deployment &&
            (r.event === 'execution' || r.event === 'completion'),
        )
        .sort((a, b) => b.id - a.id);
      for (const r of rows) {
        if ((r.detail as { outcome?: string }).outcome === 'released') {
          return r.targetRevision ?? undefined;
        }
      }
      return undefined;
    }),
    latestOutcome: vi.fn(async (deployment: string, releaseId: string) => {
      const rows = events
        .filter(
          (r) =>
            r.deployment === deployment &&
            r.releaseId === releaseId &&
            (r.event === 'execution' || r.event === 'completion'),
        )
        .sort((a, b) => b.id - a.id);
      const top = rows[0];
      return top ? (top.detail as { outcome?: ReleaseOutcome }).outcome : undefined;
    }),
    openReleases: vi.fn(async () => {
      const byRel = new Map<string, FakeRow[]>();
      for (const r of events) {
        const arr = byRel.get(r.releaseId) ?? [];
        arr.push(r);
        byRel.set(r.releaseId, arr);
      }
      const out: { deployment: string; releaseId: string; detail: Record<string, unknown> }[] = [];
      for (const [releaseId, rows] of byRel) {
        const proposal = rows.find((r) => r.event === 'proposal');
        const resolved = rows.some((r) => r.event === 'resolved');
        if (proposal && !resolved) {
          out.push({ deployment: proposal.deployment, releaseId, detail: proposal.detail });
        }
      }
      return out;
    }),
  };

  const writer = {
    append: vi.fn(async (e: Partial<FakeRow> & Pick<FakeRow, 'releaseId' | 'deployment' | 'event'>) => {
      if (failMode === 'append') throw new Error('release-ledger unavailable');
      seed(e);
    }),
    appendProposalIfAbsent: vi.fn(
      async (e: Partial<FakeRow> & Pick<FakeRow, 'releaseId' | 'deployment' | 'event'>) => {
        if (failMode === 'append') throw new Error('release-ledger unavailable');
        if (events.some((r) => r.releaseId === e.releaseId && r.event === 'proposal')) return false;
        seed(e);
        return true;
      },
    ),
    reader: () => reader,
    close: vi.fn(async () => {}),
  };

  return {
    writer,
    reader,
    events,
    seed,
    setFailMode: (m: 'none' | 'append') => {
      failMode = m;
    },
    countEvents: (kind: FakeRow['event'], releaseId?: string) =>
      events.filter((r) => r.event === kind && (releaseId ? r.releaseId === releaseId : true)).length,
  };
}

function makeFakeDecisionManager() {
  const ledger = {
    raise: vi.fn(async (req: DecisionRequest) => ({ decision_id: req.decision_id })),
    notify: vi.fn(async (_id: string) => {}),
    answer: vi.fn(async (_id: string, _ans: string, _actor: string) => {}),
    advanceToResumed: vi.fn(async (_id: string) => {}),
    statusOf: vi.fn(async (_id: string) => 'raised'),
  };
  return {
    // The RuntimeDegradable surface the governed-marking helpers call on it.
    markRuntimeDegraded: vi.fn((_reason: string) => {}),
    clearRuntimeDegraded: vi.fn(() => {}),
    // "max earned autonomy" narrative knob the lane MUST ignore for phase:release.
    autonomyLevel: 'auto-merge' as const,
    ledger: () => ledger,
    _ledger: ledger,
  };
}

function makePromotion() {
  return {
    promote: vi.fn(async (_a: { deployment: string; targetRevision: string }) => {}),
    rollback: vi.fn(
      async (_a: { deployment: string; toRevision: string | undefined }) => {},
    ),
    fireTrigger: vi.fn(
      async (_a: { deployment: string; trigger: string; targetRevision: string }) => {},
    ),
  };
}

const landingFound = (path: unknown) => ({
  readDeclaredData: vi.fn(
    (_id: string, _which: 'landing') =>
      ({ kind: 'found', value: { landsOn: 'main', productionReleasePath: path } }) as const,
  ),
});
const landingNotFound = () => ({
  readDeclaredData: vi.fn((_id: string, _which: 'landing') => ({ kind: 'not-found' }) as const),
});

const makeTrunk = (
  headSha: string,
  opts: { compare?: unknown[]; recent?: unknown[] } = {},
): TrunkReaderLike & {
  getTrunkHead: ReturnType<typeof vi.fn>;
  compareSince: ReturnType<typeof vi.fn>;
  listRecent: ReturnType<typeof vi.fn>;
} => {
  const compare = opts.compare ?? [{ sha: 'since-1', subject: 'fix #12', issueNumbers: [12] }];
  const recent =
    opts.recent ?? [
      { sha: 'recent-1', subject: 'old #99', issueNumbers: [99] },
      { sha: 'recent-2', subject: 'older #98', issueNumbers: [98] },
    ];
  const getTrunkHead = vi.fn(async () => ({ sha: headSha }));
  const compareSince = vi.fn(async () => ({ commits: compare }));
  const listRecent = vi.fn(async () => ({ commits: recent }));
  return { getTrunkHead, compareSince, listRecent };
};

const DEPLOY = 'acme/widgets';
const ISSUE = 4242;

interface HarnessOverrides {
  releasePath?: unknown;
  landing?: 'found' | 'not-found';
  headSha?: string;
  marker?: string | undefined;
  posted?: boolean;
  answer?: 'approve' | 'reject' | undefined;
}

function makeHarness(overrides: HarnessOverrides = {}) {
  const releasePath = overrides.releasePath ?? { kind: 'platform-performs' };
  const registry =
    overrides.landing === 'not-found' ? landingNotFound() : landingFound(releasePath);
  const ledger = makeFakeLedger();
  const trunkReader = makeTrunk(overrides.headSha ?? 'sha-head');
  const promotion = makePromotion();
  const decisionManager = makeFakeDecisionManager();
  const publisher = { ensure: vi.fn(async (_a: unknown) => ({ posted: overrides.posted ?? true })) };
  const sanitize = vi.fn(async (req: DecisionRequest) => req);
  const readAnswer = vi.fn(
    async (_d: string, _id: string, _issue: number) => overrides.answer,
  );

  // lastReleasedMarker override for the internal proposal assembly.
  if (overrides.marker !== undefined) {
    ledger.reader.lastReleasedMarker.mockResolvedValue(overrides.marker);
  }

  const deps = {
    registry,
    repositoriesFor: (_d: string) => [{ owner: 'acme', name: 'widgets' }] as Repo[],
    ledger: ledger.writer,
    trunkReader,
    promotion,
    decisionManager,
    publisher,
    sanitize,
    readAnswer,
    octokit: {} as unknown,
    issueNumberFor: (_d: string) => ISSUE,
  };

  return { deps, ledger, trunkReader, promotion, decisionManager, publisher, sanitize, readAnswer };
}

async function makeLane(overrides: HarnessOverrides = {}) {
  const createReleaseLane = await loadExport<CreateReleaseLane>(
    './release/executor.js',
    'createReleaseLane',
  );
  const h = makeHarness(overrides);
  return { lane: createReleaseLane(h.deps), ...h };
}

// A complete stored proposal event detail (drift-safe source of truth). The
// `sinceRevision` defaults to a placeholder; gate 8 aligns it with the derived
// prior marker so the rollback-target assertion holds whichever faithful source
// (the derived Last-Released Marker or the stored sinceRevision) the executor reads.
const seedProposalEvent = (
  ledger: ReturnType<typeof makeFakeLedger>,
  releaseId: string,
  targetRevision: string,
  declaredPath: unknown,
  sinceRevision = 'prev0000',
): void => {
  ledger.seed({
    releaseId,
    deployment: DEPLOY,
    event: 'proposal',
    targetRevision,
    detail: {
      deployment: DEPLOY,
      targetRevision,
      sinceRevision,
      coveredWork: [{ sha: 'c1', subject: 'add feature', issueNumbers: [12] }],
      declaredPath,
      summary: 'Release acme/widgets',
      issueNumber: ISSUE,
    },
  });
};

// ==========================================================================
// 1. Declared release path — discriminated 3-shape union (real schema).
// ==========================================================================

describe('gate 1 — landing.productionReleasePath discriminated 3-shape union', () => {
  const envelope = (releasePath: unknown) => ({
    repositories: [{ owner: 'acme', name: 'widgets' }],
    riskPathMap: [],
    defaultMinLevel: 'green',
    laneSet: {},
    lifecycleMode: 'governed',
    complianceReviewers: [],
    honestAutomation: { automatable: [], strained: [], irreduciblyHuman: [] },
    budget: 100,
    landing: { landsOn: 'main', productionReleasePath: releasePath },
    capabilityBindings: [],
  });

  it('accepts the three shapes and rejects string / missing-discriminant / unknown-kind / extra-keys', async () => {
    const safeParse = await loadSafeParse('./deployment-registry/schema.js', 'ProfileEnvelopeSchema');
    const accepts = (rp: unknown) => safeParse(envelope(rp)).success;

    expect(accepts({ kind: 'platform-performs' }), 'accepts platform-performs').toBe(true);
    expect(
      accepts({ kind: 'trigger-automated', trigger: 'deploy.yml' }),
      'accepts trigger-automated',
    ).toBe(true);
    expect(
      accepts({ kind: 'record-only', procedure: 'runbook#release' }),
      'accepts record-only',
    ).toBe(true);

    expect(accepts('tag-and-deploy'), 'rejects the old bare string').toBe(false);
    expect(accepts({ kind: 'trigger-automated' }), 'rejects missing trigger').toBe(false);
    expect(accepts({ kind: 'record-only' }), 'rejects missing procedure').toBe(false);
    expect(accepts({ kind: 'yolo' }), 'rejects unknown kind').toBe(false);
    expect(
      accepts({ kind: 'platform-performs', extra: 1 }),
      'rejects extra keys (.strict)',
    ).toBe(false);
  });
});

// ==========================================================================
// 2–4. The 4th builder — buildReleaseDecisionRequest.
// ==========================================================================

const builderProposal: ReleaseProposalLike = {
  deployment: DEPLOY,
  targetRevision: 'abc123456789',
  sinceRevision: 'prev0000',
  coveredWork: [{ sha: 'c1', subject: 'add feature', issueNumbers: [12, 14] }],
  declaredPath: { kind: 'platform-performs' },
  summary: 'Release acme/widgets: 1 change since prev0000 → abc12345',
};

describe('gate 2 — builder shape', () => {
  it('parses through the REAL DecisionRequestSchema as a release-phase approve/reject P0 external-effect decision', async () => {
    const build = await loadExport<BuildReleaseDecisionRequest>(
      './release/build-request.js',
      'buildReleaseDecisionRequest',
    );
    const req = DecisionRequestSchema.parse(build(builderProposal, { now: NOW }));
    expect(req.phase).toBe('release');
    expect(req.risk_class).toBe('P0');
    expect(req.reversibility).toBe('external_effect');
    expect([...new Set(req.options.map((o) => o.id))].sort()).toEqual(['approve', 'reject']);
    expect(req.answer_schema).toEqual({ kind: 'option' });
  });
});

describe('gate 3 — builder determinism / idempotency', () => {
  it('decision_id === idempotency_key === release:<deployment>:<sha8> and is stable across a later re-propose', async () => {
    const build = await loadExport<BuildReleaseDecisionRequest>(
      './release/build-request.js',
      'buildReleaseDecisionRequest',
    );
    const releaseDecisionId = await loadExport<ReleaseDecisionId>(
      './release/build-request.js',
      'releaseDecisionId',
    );
    const a = build(builderProposal, { now: NOW });
    const b = build(builderProposal, { now: '2026-07-03T09:00:00.000Z' });
    expect(a.decision_id).toBe(releaseDecisionId(DEPLOY, 'abc123456789'));
    expect(a.decision_id).toBe(a.idempotency_key);
    expect(b.decision_id).toBe(a.decision_id);
  });
});

describe('gate 4 — builder context safety', () => {
  it('carries ONLY structured-safe context — never a raw commit subject/body', async () => {
    const build = await loadExport<BuildReleaseDecisionRequest>(
      './release/build-request.js',
      'buildReleaseDecisionRequest',
    );
    const req = build(
      {
        ...builderProposal,
        coveredWork: [
          { sha: 'c1', subject: 'SECRET token=abc; DROP TABLE users;', issueNumbers: [] },
        ],
      },
      { now: NOW },
    );
    const blob = `${req.question} ${req.context}`;
    expect(blob).not.toContain('DROP TABLE');
    expect(blob).not.toContain('SECRET token');
  });
});

// ==========================================================================
// 16. Proposal assembly — since-diff source + fail-closed + nothing-to-release.
// (Placed here so the proposal fakes read alongside the builder ones.)
// ==========================================================================

describe('gate 16 — proposal fail-closed + since-diff source + nothing-to-release', () => {
  const SINCE = [{ sha: 'since-1', subject: 'fix #12', issueNumbers: [12] }];
  const RECENT = [
    { sha: 'recent-1', subject: 'old #99', issueNumbers: [99] },
    { sha: 'recent-2', subject: 'older #98', issueNumbers: [98] },
  ];

  it('diffs compareSince(base=marker,head) NOT listRecent, and coveredWork equals the since-diff set', async () => {
    const assemble = await loadExport<AssembleReleaseProposal>(
      './release/proposal.js',
      'assembleReleaseProposal',
    );
    const trunk = makeTrunk('sha-head', { compare: SINCE, recent: RECENT });
    const res = await assemble({
      deployment: DEPLOY,
      registry: landingFound({ kind: 'platform-performs' }),
      repositories: [{ owner: 'acme', name: 'widgets' }],
      ledgerReader: { lastReleasedMarker: async () => 'sha-prev' },
      trunkReader: trunk,
    });
    expect(res.kind).toBe('proposal');
    expect(trunk.compareSince).toHaveBeenCalledWith('acme', 'widgets', 'sha-prev', 'sha-head');
    expect(trunk.listRecent).not.toHaveBeenCalled();
    expect(res.proposal?.sinceRevision).toBe('sha-prev');
    expect(res.proposal?.targetRevision).toBe('sha-head');
    expect(res.proposal?.coveredWork).toEqual(SINCE);
  });

  it('reports nothing-to-release when trunk head equals the derived marker', async () => {
    const assemble = await loadExport<AssembleReleaseProposal>(
      './release/proposal.js',
      'assembleReleaseProposal',
    );
    const res = await assemble({
      deployment: DEPLOY,
      registry: landingFound({ kind: 'platform-performs' }),
      repositories: [{ owner: 'acme', name: 'widgets' }],
      ledgerReader: { lastReleasedMarker: async () => 'sha-head' },
      trunkReader: makeTrunk('sha-head', { compare: SINCE, recent: RECENT }),
    });
    expect(res.kind).toBe('nothing-to-release');
  });

  it('is unresolvable (fail closed) when landing is not declared', async () => {
    const assemble = await loadExport<AssembleReleaseProposal>(
      './release/proposal.js',
      'assembleReleaseProposal',
    );
    const res = await assemble({
      deployment: DEPLOY,
      registry: landingNotFound(),
      repositories: [{ owner: 'acme', name: 'widgets' }],
      ledgerReader: { lastReleasedMarker: async () => undefined },
      trunkReader: makeTrunk('sha-head'),
    });
    expect(res.kind).toBe('unresolvable');
  });

  it('is unresolvable when productionReleasePath is malformed (not one of the 3 shapes)', async () => {
    const assemble = await loadExport<AssembleReleaseProposal>(
      './release/proposal.js',
      'assembleReleaseProposal',
    );
    const res = await assemble({
      deployment: DEPLOY,
      registry: landingFound('tag-and-deploy'),
      repositories: [{ owner: 'acme', name: 'widgets' }],
      ledgerReader: { lastReleasedMarker: async () => undefined },
      trunkReader: makeTrunk('sha-head'),
    });
    expect(res.kind).toBe('unresolvable');
  });
});

// ==========================================================================
// 5, 17. proposeRelease — always raises, sanitizes, fail-closed on posted:false.
// ==========================================================================

describe('gate 5 — always-raises / never-earns-autonomy', () => {
  it('proposeRelease raises (sanitize + ledger.raise + publisher.ensure) and applies NO answer, even at max earned autonomy', async () => {
    const { lane, decisionManager, sanitize, publisher, ledger } = await makeLane({ marker: 'sha-prev' });
    const res = await lane.proposeRelease(DEPLOY);
    expect(res.kind).toBe('raised');
    expect(sanitize).toHaveBeenCalled();
    expect(decisionManager._ledger.raise).toHaveBeenCalled();
    expect(publisher.ensure).toHaveBeenCalled();
    // No auto-resolve path: the decision is never answered/resumed during propose.
    expect(decisionManager._ledger.answer).not.toHaveBeenCalled();
    expect(decisionManager._ledger.advanceToResumed).not.toHaveBeenCalled();
    // Exactly one proposal event, appended atomically.
    expect(ledger.countEvents('proposal')).toBe(1);
  });
});

describe('gate 17 — decision transport degraded is fail-closed + marked', () => {
  it('publisher.ensure {posted:false} → degraded (NOT raised), no notify, marks the deployment degraded', async () => {
    const { lane, decisionManager } = await makeLane({ marker: 'sha-prev', posted: false });
    const res = await lane.proposeRelease(DEPLOY);
    expect(res.kind).toBe('degraded');
    expect(decisionManager._ledger.notify).not.toHaveBeenCalled();
    expect(decisionManager.markRuntimeDegraded).toHaveBeenCalled();
  });
});

// ==========================================================================
// 6. Preview never mutates.
// ==========================================================================

describe('gate 6 — preview never mutates', () => {
  it('previewRelease returns a proposal, calls no PromotionPort method, and appends NO ledger event', async () => {
    const { lane, promotion, ledger } = await makeLane({ marker: 'sha-prev' });
    const res = await lane.previewRelease(DEPLOY);
    expect(res.kind).toBe('proposal');
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(promotion.fireTrigger).not.toHaveBeenCalled();
    expect(ledger.events).toHaveLength(0);
  });
});

// ==========================================================================
// 7–11. Executor shape outcomes (verified approve).
// ==========================================================================

describe('gate 7 — platform-performs success', () => {
  it('promote resolves → execution released appended after promote, rollback not called', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res).toEqual(expect.objectContaining({ kind: 'executed', outcome: 'released' }));
    expect(promotion.promote).toHaveBeenCalledTimes(1);
    expect(promotion.rollback).not.toHaveBeenCalled();
    const exec = ledger.events.find((r) => r.event === 'execution');
    expect(exec?.detail).toEqual(expect.objectContaining({ outcome: 'released' }));
  });
});

describe('gate 8 — platform-performs fail-safe (incl. rollback throws)', () => {
  it('promote throws → rollback(toRevision=priorMarker) + execution failed (never released)', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve', marker: 'sha-prior' });
    ledger.seed({ releaseId: 'r0', deployment: DEPLOY, event: 'execution', targetRevision: 'sha-prior', detail: { outcome: 'released' } });
    promotion.promote.mockRejectedValueOnce(new Error('promote failed'));
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' }, 'sha-prior');
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res).toEqual(expect.objectContaining({ kind: 'executed', outcome: 'failed' }));
    expect(promotion.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ toRevision: 'sha-prior' }),
    );
    const exec = ledger.events.find((r) => r.event === 'execution' && r.releaseId === releaseId);
    expect(exec?.detail).toEqual(expect.objectContaining({ outcome: 'failed' }));
    expect(exec?.detail).not.toEqual(expect.objectContaining({ outcome: 'released' }));
  });

  it('promote AND rollback both throw → execution failed (rollbackFailed:true) + marks degraded, never released', async () => {
    const { lane, ledger, promotion, decisionManager } = await makeLane({ answer: 'approve' });
    promotion.promote.mockRejectedValueOnce(new Error('promote failed'));
    promotion.rollback.mockRejectedValueOnce(new Error('rollback failed'));
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res.outcome).toBe('failed');
    const exec = ledger.events.find((r) => r.event === 'execution' && r.releaseId === releaseId);
    expect(exec?.detail).toEqual(
      expect.objectContaining({ outcome: 'failed', rollbackFailed: true }),
    );
    expect(decisionManager.markRuntimeDegraded).toHaveBeenCalled();
    expect(
      ledger.events.some(
        (r) => r.event === 'execution' && (r.detail as { outcome?: string }).outcome === 'released',
      ),
    ).toBe(false);
  });
});

describe('gate 9 — trigger-automated fires', () => {
  it('fireTrigger resolves → execution triggered-awaiting (non-final), promote never called', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', {
      kind: 'trigger-automated',
      trigger: 'deploy.yml',
    });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res).toEqual(expect.objectContaining({ kind: 'executed', outcome: 'triggered-awaiting' }));
    expect(promotion.fireTrigger).toHaveBeenCalledTimes(1);
    expect(promotion.promote).not.toHaveBeenCalled();
  });
});

describe('gate 10 — trigger-automated cannot fire', () => {
  it('fireTrigger throws → execution failed, nothing promoted', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve' });
    promotion.fireTrigger.mockRejectedValueOnce(new Error('dispatch rejected'));
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', {
      kind: 'trigger-automated',
      trigger: 'deploy.yml',
    });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res.outcome).toBe('failed');
    expect(promotion.promote).not.toHaveBeenCalled();
    const exec = ledger.events.find((r) => r.event === 'execution' && r.releaseId === releaseId);
    expect(exec?.detail).toEqual(expect.objectContaining({ outcome: 'failed' }));
  });
});

describe('gate 11 — record-only', () => {
  it('execution recorded-awaiting-human appended, PromotionPort NEVER called', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', {
      kind: 'record-only',
      procedure: 'runbook#release',
    });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res).toEqual(
      expect.objectContaining({ kind: 'executed', outcome: 'recorded-awaiting-human' }),
    );
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(promotion.fireTrigger).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// 12, 18. resolveRelease — reject + verified-answer only.
// ==========================================================================

describe('gate 12 — reject (verified)', () => {
  it('readAnswer→reject → decision event only, production untouched, {kind:rejected}', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: 'reject' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res.kind).toBe('rejected');
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(ledger.countEvents('execution', releaseId)).toBe(0);
    expect(ledger.countEvents('decision', releaseId)).toBe(1);
  });
});

describe('gate 18 — resolveRelease acts ONLY on a verified answer', () => {
  it('readAnswer→undefined → pending, NO decision/execution event, no promotion', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: undefined });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res.kind).toBe('pending');
    expect(ledger.countEvents('decision', releaseId)).toBe(0);
    expect(ledger.countEvents('execution', releaseId)).toBe(0);
    expect(promotion.promote).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// 13. Declared-path fail-closed (typed).
// ==========================================================================

describe('gate 13 — declared-path fail-closed (typed)', () => {
  it('approved release whose STORED declared path is invalid → unresolvable, no execution, no promotion', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    // Stored proposal carries a malformed path (drift-safe source is authoritative).
    seedProposalEvent(ledger, releaseId, 'sha-approved', 'tag-and-deploy');
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res.kind).toBe('unresolvable');
    expect(res.reason).toBeTruthy();
    expect(ledger.countEvents('execution', releaseId)).toBe(0);
    expect(promotion.promote).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// 14. recordCompletion terminal guard.
// ==========================================================================

describe('gate 14 — recordCompletion terminal guard', () => {
  it('completing an already-released release is already-terminal and appends no event', async () => {
    const { lane, ledger } = await makeLane();
    const releaseId = 'release:acme/widgets:sha-appr';
    ledger.seed({
      releaseId,
      deployment: DEPLOY,
      event: 'execution',
      targetRevision: 'sha-approved',
      detail: { outcome: 'released' },
    });
    const before = ledger.events.length;
    const result = await lane.recordCompletion(DEPLOY, releaseId, 'released');
    expect(result).toBe('already-terminal');
    expect(ledger.events.length).toBe(before);
  });

  it('completing a triggered-awaiting release is applied and appends a completion event', async () => {
    const { lane, ledger } = await makeLane();
    const releaseId = 'release:acme/widgets:sha-appr';
    ledger.seed({
      releaseId,
      deployment: DEPLOY,
      event: 'execution',
      targetRevision: 'sha-approved',
      detail: { outcome: 'triggered-awaiting' },
    });
    const result = await lane.recordCompletion(DEPLOY, releaseId, 'released');
    expect(result).toBe('applied');
    expect(ledger.countEvents('completion', releaseId)).toBe(1);
  });
});

// ==========================================================================
// 15. Manager fail-closed + ledger-unavailable refuse (+ marks degraded).
// ==========================================================================

describe('gate 15 — manager fail-closed init + ledger-unavailable refuse', () => {
  it('ReleaseLedgerManager with a throwing opener is #broken (isAvailable=false, ledger() throws /unavailable/)', async () => {
    const Manager = await loadExport<ReleaseLedgerManagerCtor>(
      './release/release-ledger-manager.js',
      'ReleaseLedgerManager',
    );
    const m = new Manager({
      enabled: true,
      databaseUrl: 'postgres://x',
      opener: async () => {
        throw new Error('open failed');
      },
    });
    await m.init();
    expect(m.isAvailable()).toBe(false);
    expect(() => m.ledger()).toThrow(/unavailable/i);
  });

  it('proposeRelease + resolveRelease return degraded and mark degraded when the ledger is unavailable', async () => {
    const proposeH = await makeLane({ marker: 'sha-prev' });
    proposeH.ledger.setFailMode('append');
    const p = await proposeH.lane.proposeRelease(DEPLOY);
    expect(p.kind).toBe('degraded');
    expect(proposeH.decisionManager.markRuntimeDegraded).toHaveBeenCalled();

    const resolveH = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(resolveH.ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    resolveH.ledger.setFailMode('append');
    const r = await resolveH.lane.resolveRelease(DEPLOY, releaseId);
    expect(r.kind).toBe('degraded');
    expect(resolveH.decisionManager.markRuntimeDegraded).toHaveBeenCalled();
  });
});

// ==========================================================================
// 19. Exactly-once execution + crash-recovery (+ the sweep) + terminalization.
// ==========================================================================

describe('gate 19 — exactly-once + crash-recovery + terminalization', () => {
  it('(a) a second resolveRelease after one execution is already-resolved with NO second execution', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    const first = await lane.resolveRelease(DEPLOY, releaseId);
    expect(first).toEqual(expect.objectContaining({ kind: 'executed', outcome: 'released' }));
    const second = await lane.resolveRelease(DEPLOY, releaseId);
    expect(second.kind).toBe('already-resolved');
    expect(promotion.promote).toHaveBeenCalledTimes(1);
    expect(ledger.countEvents('execution', releaseId)).toBe(1);
  });

  it('(b) a decision(approve)-only release resumes to execution + resolved', async () => {
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    ledger.seed({ releaseId, deployment: DEPLOY, event: 'decision', detail: { answer: 'approve' } });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res).toEqual(expect.objectContaining({ kind: 'executed', outcome: 'released' }));
    expect(promotion.promote).toHaveBeenCalledTimes(1);
    expect(ledger.countEvents('resolved', releaseId)).toBe(1);
  });

  it('(c) an executed-but-not-resolved release re-runs ONLY terminalize (no second execution)', async () => {
    const { lane, ledger, promotion, decisionManager } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    ledger.seed({ releaseId, deployment: DEPLOY, event: 'decision', detail: { answer: 'approve' } });
    ledger.seed({
      releaseId,
      deployment: DEPLOY,
      event: 'execution',
      targetRevision: 'sha-approved',
      detail: { outcome: 'released' },
    });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res.kind).toBe('already-resolved');
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(ledger.countEvents('execution', releaseId)).toBe(1);
    expect(decisionManager._ledger.advanceToResumed).toHaveBeenCalled();
    expect(ledger.countEvents('resolved', releaseId)).toBe(1);
  });

  it('(d) an attempt with NO terminal execution → execution failed (interrupted-outcome-unknown) + marks degraded, never re-fires', async () => {
    const { lane, ledger, promotion, decisionManager } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    ledger.seed({ releaseId, deployment: DEPLOY, event: 'decision', detail: { answer: 'approve' } });
    ledger.seed({
      releaseId,
      deployment: DEPLOY,
      event: 'attempt',
      targetRevision: 'sha-approved',
      detail: { shape: 'platform-performs' },
    });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res.outcome).toBe('failed');
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(promotion.fireTrigger).not.toHaveBeenCalled();
    const exec = ledger.events.find((r) => r.event === 'execution' && r.releaseId === releaseId);
    expect(exec?.detail).toEqual(
      expect.objectContaining({ outcome: 'failed', reason: 'interrupted-outcome-unknown' }),
    );
    expect(decisionManager.markRuntimeDegraded).toHaveBeenCalled();
  });

  it('(e) a successful resolve calls ledger.answer THEN advanceToResumed THEN appends resolved', async () => {
    const { lane, ledger, decisionManager } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    await lane.resolveRelease(DEPLOY, releaseId);
    const answerOrder = decisionManager._ledger.answer.mock.invocationCallOrder[0];
    const resumeOrder = decisionManager._ledger.advanceToResumed.mock.invocationCallOrder[0];
    expect(answerOrder).toBeDefined();
    expect(resumeOrder).toBeDefined();
    expect(answerOrder!).toBeLessThan(resumeOrder!);
    expect(ledger.countEvents('resolved', releaseId)).toBe(1);
  });

  it('(f) the SWEEP re-picks a decision-only release via openReleases, drives it to resolved, and never re-picks it after', async () => {
    const resolveAnsweredReleases = await loadExport<ResolveAnsweredReleases>(
      './release/resolve-consumer.js',
      'resolveAnsweredReleases',
    );
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    ledger.seed({ releaseId, deployment: DEPLOY, event: 'decision', detail: { answer: 'approve' } });

    await resolveAnsweredReleases({ lane, reader: ledger.reader });
    expect(promotion.promote).toHaveBeenCalledTimes(1);
    expect(ledger.countEvents('resolved', releaseId)).toBe(1);
    expect(await ledger.reader.openReleases()).toHaveLength(0);

    // Second sweep is a no-op — the resolved release is not re-picked / re-executed.
    await resolveAnsweredReleases({ lane, reader: ledger.reader });
    expect(promotion.promote).toHaveBeenCalledTimes(1);
    expect(ledger.countEvents('execution', releaseId)).toBe(1);
  });
});

// ==========================================================================
// 20. Drift-safety — the APPROVED target AND path are executed.
// ==========================================================================

describe('gate 20 — drift-safety (stored target + stored path win over current registry/trunk)', () => {
  it('(a) executes the STORED target sha-approved even when the trunk head is now sha-newer', async () => {
    // Registry/trunk drift forward; the stored proposal is authoritative.
    const { lane, ledger, promotion } = await makeLane({ answer: 'approve', headSha: 'sha-newer' });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', { kind: 'platform-performs' });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res.outcome).toBe('released');
    expect(promotion.promote).toHaveBeenCalledWith(
      expect.objectContaining({ targetRevision: 'sha-approved' }),
    );
    const exec = ledger.events.find((r) => r.event === 'execution' && r.releaseId === releaseId);
    expect(exec?.targetRevision).toBe('sha-approved');
  });

  it('(b) uses the STORED record-only path (no promotion) even when the registry now says platform-performs', async () => {
    // Stored path is record-only; the CURRENT registry declares platform-performs.
    const { lane, ledger, promotion } = await makeLane({
      answer: 'approve',
      releasePath: { kind: 'platform-performs' },
    });
    const releaseId = 'release:acme/widgets:sha-appr';
    seedProposalEvent(ledger, releaseId, 'sha-approved', {
      kind: 'record-only',
      procedure: 'runbook#release',
    });
    const res = await lane.resolveRelease(DEPLOY, releaseId);
    expect(res.outcome).toBe('recorded-awaiting-human');
    expect(promotion.promote).not.toHaveBeenCalled();
    expect(promotion.fireTrigger).not.toHaveBeenCalled();
  });

  it('(c) is unresolvable when no proposal event exists for the releaseId', async () => {
    const { lane, promotion } = await makeLane({ answer: 'approve' });
    const res = await lane.resolveRelease(DEPLOY, 'release:acme/widgets:missing0');
    expect(res.kind).toBe('unresolvable');
    expect(promotion.promote).not.toHaveBeenCalled();
  });
});
