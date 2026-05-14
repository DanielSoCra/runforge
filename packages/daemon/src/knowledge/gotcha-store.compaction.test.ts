import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gotcha } from '../types.js';

let logEntries: Gotcha[];
let readJsonlMock: ReturnType<typeof vi.fn>;
let appendJsonlMock: ReturnType<typeof vi.fn>;
let writeTextSafeMock: ReturnType<typeof vi.fn>;

const storePath = '/state/gotchas.jsonl';

function cloneGotcha(gotcha: Gotcha): Gotcha {
  return {
    ...gotcha,
    artifactPatterns: [...gotcha.artifactPatterns],
  };
}

function cloneGotchas(gotchas: Gotcha[]): Gotcha[] {
  return gotchas.map(cloneGotcha);
}

function makeGotcha(overrides: Partial<Gotcha> = {}): Gotcha {
  return {
    id: 'gotcha-1',
    artifactPatterns: ['src/**/*.ts'],
    description: 'Repeated compaction pitfall',
    sourceIssue: 581,
    confidence: 1,
    createdAt: '2026-05-14T00:00:00.000Z',
    hitCount: 1,
    promoted: false,
    archived: false,
    originType: 'autonomous',
    priorityTier: 'normal',
    ...overrides,
  };
}

async function createStore() {
  const { GotchaStore } = await import('./gotcha-store.js');
  return new GotchaStore(storePath);
}

describe('GotchaStore compaction reads', () => {
  beforeEach(() => {
    vi.resetModules();
    logEntries = [];
    readJsonlMock = vi.fn(async () => cloneGotchas(logEntries));
    appendJsonlMock = vi.fn(async (_path: string, entry: Gotcha) => {
      logEntries.push(cloneGotcha(entry));
    });
    writeTextSafeMock = vi.fn(async (_path: string, content: string) => {
      logEntries = content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as Gotcha);
    });

    vi.doMock('../lib/json-store.js', () => ({
      appendJsonl: appendJsonlMock,
      readJsonl: readJsonlMock,
      writeTextSafe: writeTextSafeMock,
    }));
  });

  afterEach(() => {
    vi.doUnmock('../lib/json-store.js');
  });

  it('reuses the loaded log when checking compaction after store', async () => {
    const store = await createStore();

    await store.store(
      [{ artifactPatterns: ['src/**/*.ts'], description: 'Avoid duplicate reads' }],
      581,
    );

    expect(readJsonlMock).toHaveBeenCalledTimes(1);
    expect(logEntries).toHaveLength(1);
  });

  it('does not reread the log when compaction triggers after store', async () => {
    logEntries = Array.from({ length: 49 }, (_, index) =>
      makeGotcha({ hitCount: index + 1 }),
    );
    const store = await createStore();

    await store.store(
      [{ artifactPatterns: ['src/**/*.ts'], description: 'Repeated compaction pitfall' }],
      581,
    );

    expect(readJsonlMock).toHaveBeenCalledTimes(1);
    expect(writeTextSafeMock).toHaveBeenCalledTimes(1);
    expect(logEntries).toHaveLength(1);
    expect(logEntries[0]!.hitCount).toBe(50);
  });
});
