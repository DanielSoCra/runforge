import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../drizzle/0002_cost_events_provider_usage.sql', import.meta.url),
  'utf8',
);
const journal = JSON.parse(
  readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: { idx: number; tag: string }[] };

describe('cost_events spend-attribution migration (0002)', () => {
  it('adds the provider and usage_units columns through the Migration Runner', () => {
    expect(migration).toContain(
      'ALTER TABLE "cost_events" ADD COLUMN "provider" text;',
    );
    expect(migration).toContain(
      'ALTER TABLE "cost_events" ADD COLUMN "usage_units" bigint;',
    );
  });

  it('keeps both columns nullable with no default — NULL means unattributed', () => {
    // A NOT NULL constraint or a real-looking default would fabricate
    // attribution for pre-migration rows; the spend projection must surface
    // them as an explicit unattributed bucket instead.
    expect(migration).not.toMatch(/NOT NULL/i);
    expect(migration).not.toMatch(/DEFAULT/i);
  });

  it('is forward-only: no destructive statements', () => {
    expect(migration).not.toMatch(/DROP|TRUNCATE|DELETE/i);
  });

  it('is registered in the migration journal after the operator-auth entry', () => {
    expect(journal.entries.map((entry) => entry.tag)).toEqual([
      '0000_self_hosted_data_platform',
      '0001_operator_auth_tables',
      '0002_cost_events_provider_usage',
    ]);
  });
});
