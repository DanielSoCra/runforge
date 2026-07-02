// G5 gate: implemented decision surfaces must not retain stale STUB comments.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const forbiddenMarker = 'STUB: not implemented';

const files = [
  {
    path: 'packages/dashboard/app/api/decisions/pending/route.ts',
    url: new URL('../../app/api/decisions/pending/route.ts', import.meta.url),
  },
  {
    path: 'packages/dashboard/components/decisions/decision-inbox.tsx',
    url: new URL('../decisions/decision-inbox.tsx', import.meta.url),
  },
] as const;

describe('P3 G5 stale STUB cleanup gate', () => {
  it('removes stale STUB markers from implemented decision files', async () => {
    const contents = await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        content: await readFile(file.url, 'utf8'),
      })),
    );

    const offenders = contents
      .filter((file) => file.content.includes(forbiddenMarker))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
