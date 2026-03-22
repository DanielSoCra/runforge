// src/control-plane/results.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendResult, readResults } from './results.js';
import type { ResultsRecord } from '../types.js';

const makeRecord = (issueNumber: number): ResultsRecord => ({
  issueNumber,
  startedAt: '2026-03-19T10:00:00.000Z',
  completedAt: '2026-03-19T10:05:00.000Z',
  variant: 'feature-simple',
  totalCost: 1.23,
  phasesExecuted: ['detect', 'classify', 'implement', 'review', 'report'],
  fixAttemptCount: 0,
  outcome: 'complete',
});

describe('results ledger', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'results-'));
  });

  it('appends and reads a single result', async () => {
    const record = makeRecord(42);
    await appendResult(record, stateDir);
    const results = await readResults(stateDir);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(record);
  });

  it('appends and reads multiple results', async () => {
    await appendResult(makeRecord(1), stateDir);
    await appendResult(makeRecord(2), stateDir);
    await appendResult(makeRecord(3), stateDir);
    const results = await readResults(stateDir);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.issueNumber)).toEqual([1, 2, 3]);
  });

  it('returns empty array for missing file', async () => {
    const results = await readResults(stateDir);
    expect(results).toEqual([]);
  });

  it('preserves all fields including optional ones', async () => {
    const record: ResultsRecord = {
      ...makeRecord(10),
      complexity: 'simple',
      holdoutPassed: true,
      diagnosisType: 'A',
      diagnosisConfidence: 0.9,
      warmupApproved: false,
      sampled: true,
    };
    await appendResult(record, stateDir);
    const results = await readResults(stateDir);
    expect(results[0]).toEqual(record);
  });

  it('uses default state/results.jsonl path when stateDir not provided', async () => {
    // Use a temp dir as CWD so we don't pollute the real state dir
    const tempDir = await mkdtemp(join(tmpdir(), 'results-default-'));
    const origCwd = process.cwd();
    process.chdir(tempDir);

    try {
      await mkdir(join(tempDir, 'state'), { recursive: true });

      const record = makeRecord(99);
      await appendResult(record);
      const results = await readResults();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(record);
    } finally {
      process.chdir(origCwd);
    }
  });
});
