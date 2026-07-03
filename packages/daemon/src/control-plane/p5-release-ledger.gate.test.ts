// P5 release-lane IMMOVABLE acceptance gate — PGlite (real in-process Postgres)
// criteria 21–24. These exercise the append-only Release Ledger store directly.
//
// Authored RED against HEAD: the `@auto-claude/release-ledger` package does not
// exist yet. Each test dynamic-imports the package's own PGlite test harness
// (`test/helpers/temp-db.ts` → `makeTempLedger()`, the shape the plan mandates)
// through a `string`-widened specifier so tsc never resolves it (no TS2307) and
// vitest can COLLECT the file; against HEAD the import throws inside the async
// test and is converted to a clean failing assertion (not a collection crash).
// The store's PGlite deps resolve from the release-ledger package once it lands
// (proven viable: a daemon vitest can drive a sibling package's PGlite helper).
//
// Source of truth: docs/superpowers/plans/2026-07-03-p5-release-lane.md
// §"Immovable Acceptance-Gate Spec" (criteria 21–24).

import { afterEach, describe, expect, it } from 'vitest';

interface AppendEvent {
  releaseId: string;
  deployment: string;
  event: 'proposal' | 'decision' | 'attempt' | 'execution' | 'completion' | 'resolved';
  targetRevision?: string | null;
  detail?: Record<string, unknown>;
  at?: string;
}
interface LedgerReaderLike {
  eventsForRelease: (
    deployment: string,
    releaseId: string,
  ) => Promise<{ event: string; targetRevision: string | null; detail: Record<string, unknown> }[]>;
  lastReleasedMarker: (deployment: string) => Promise<string | undefined>;
  latestOutcome: (deployment: string, releaseId: string) => Promise<string | undefined>;
  openReleases: () => Promise<
    { deployment: string; releaseId: string; detail: Record<string, unknown> }[]
  >;
}
interface LedgerWriterLike {
  append: (e: AppendEvent) => Promise<void>;
  appendProposalIfAbsent: (e: AppendEvent) => Promise<boolean>;
  reader: () => LedgerReaderLike;
  close?: () => Promise<void>;
}
type MakeTempLedger = () => Promise<{ writer: LedgerWriterLike; cleanup: () => Promise<void> }>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) {
    const c = cleanups.pop();
    if (c) await c().catch(() => {});
  }
});

async function openLedger(): Promise<LedgerWriterLike> {
  // Widened specifier: tsc must NOT resolve a not-yet-existing module.
  const p: string = '../../../release-ledger/test/helpers/temp-db.js';
  let record: Record<string, unknown> = {};
  try {
    record = (await import(p)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `gate: @auto-claude/release-ledger test helper (${p}) must exist and export makeTempLedger — ${(err as Error).message}`,
    );
  }
  const make = record['makeTempLedger'];
  expect(
    make,
    'gate: makeTempLedger must be exported by the release-ledger PGlite test helper',
  ).toBeTypeOf('function');
  const { writer, cleanup } = await (make as MakeTempLedger)();
  cleanups.push(cleanup);
  return writer;
}

const D = 'acme/widgets';

// ==========================================================================
// 21. Append-only + end-to-end read.
// ==========================================================================

describe('gate 21 — Release Ledger append-only + read-back in order', () => {
  it('reads proposal → decision → execution back in append order for a release_id', async () => {
    const w = await openLedger();
    const r = 'release:acme/widgets:abc12345';
    await w.append({ releaseId: r, deployment: D, event: 'proposal', targetRevision: 'abc12345', detail: { covered: 2 } });
    await w.append({ releaseId: r, deployment: D, event: 'decision', targetRevision: null, detail: { answer: 'approve' } });
    await w.append({ releaseId: r, deployment: D, event: 'execution', targetRevision: 'abc12345', detail: { outcome: 'released' } });
    const rows = await w.reader().eventsForRelease(D, r);
    expect(rows.map((x) => x.event)).toEqual(['proposal', 'decision', 'execution']);
  });
});

// ==========================================================================
// 22. Last-Released Marker is DERIVED from the most recent released event.
// ==========================================================================

describe('gate 22 — Last-Released Marker derivation', () => {
  it('advances only on a released event (not on triggered-awaiting / failed); completion(released) advances; undefined when never released', async () => {
    const w = await openLedger();
    const reader = w.reader();

    expect(await reader.lastReleasedMarker('never/released')).toBeUndefined();

    await w.append({ releaseId: 'r1', deployment: D, event: 'execution', targetRevision: 'sha-A', detail: { outcome: 'released' } });
    expect(await reader.lastReleasedMarker(D)).toBe('sha-A');

    await w.append({ releaseId: 'r2', deployment: D, event: 'execution', targetRevision: 'sha-B', detail: { outcome: 'triggered-awaiting' } });
    expect(await reader.lastReleasedMarker(D)).toBe('sha-A'); // non-final: does NOT advance

    await w.append({ releaseId: 'r2', deployment: D, event: 'completion', targetRevision: 'sha-B', detail: { outcome: 'released' } });
    expect(await reader.lastReleasedMarker(D)).toBe('sha-B'); // completion(released) advances

    await w.append({ releaseId: 'r3', deployment: D, event: 'execution', targetRevision: 'sha-C', detail: { outcome: 'failed' } });
    expect(await reader.lastReleasedMarker(D)).toBe('sha-B'); // failed never advances
  });
});

// ==========================================================================
// 23. openReleases enumeration (crash-safe).
// ==========================================================================

describe('gate 23 — openReleases crash-safe enumeration', () => {
  it('a proposal appears (with detail), STILL appears after a decision (crash-stranded), and disappears only once resolved', async () => {
    const w = await openLedger();
    const reader = w.reader();
    const r = 'release:acme/widgets:open0001';

    await w.appendProposalIfAbsent({
      releaseId: r,
      deployment: D,
      event: 'proposal',
      targetRevision: 'open0001',
      detail: { targetRevision: 'open0001', issueNumber: 7 },
    });
    let open = await reader.openReleases();
    expect(open.map((o) => o.releaseId)).toContain(r);
    expect(open.find((o) => o.releaseId === r)?.detail).toEqual(
      expect.objectContaining({ issueNumber: 7 }),
    );

    await w.append({ releaseId: r, deployment: D, event: 'decision', targetRevision: null, detail: { answer: 'approve' } });
    open = await reader.openReleases();
    expect(open.map((o) => o.releaseId)).toContain(r); // crash-stranded: still open

    await w.append({ releaseId: r, deployment: D, event: 'resolved', targetRevision: null, detail: { answer: 'approve' } });
    open = await reader.openReleases();
    expect(open.map((o) => o.releaseId)).not.toContain(r); // dropped only after resolved
  });
});

// ==========================================================================
// 24. Atomic single-proposal-per-release (partial unique index).
// ==========================================================================

describe('gate 24 — atomic single-proposal-per-release', () => {
  it('sequential re-propose appends exactly one proposal row (idempotent)', async () => {
    const w = await openLedger();
    const r = 'release:acme/widgets:seq00001';
    const e: AppendEvent = { releaseId: r, deployment: D, event: 'proposal', targetRevision: 'seq00001', detail: { n: 1 } };
    const first = await w.appendProposalIfAbsent(e);
    const second = await w.appendProposalIfAbsent({ ...e, detail: { n: 2 } });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const rows = await w.reader().eventsForRelease(D, r);
    expect(rows.filter((x) => x.event === 'proposal')).toHaveLength(1);
  });

  it('concurrent proposes append exactly one proposal row (partial unique index rejects the second at commit)', async () => {
    const w = await openLedger();
    const r = 'release:acme/widgets:conc0001';
    const e: AppendEvent = { releaseId: r, deployment: D, event: 'proposal', targetRevision: 'conc0001', detail: { n: 1 } };
    const results = await Promise.all([
      w.appendProposalIfAbsent(e),
      w.appendProposalIfAbsent({ ...e, detail: { n: 2 } }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one call inserted
    const rows = await w.reader().eventsForRelease(D, r);
    expect(rows.filter((x) => x.event === 'proposal')).toHaveLength(1);
  });
});
