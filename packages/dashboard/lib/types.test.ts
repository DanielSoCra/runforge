import { describe, it, expectTypeOf } from 'vitest';
import type { Database } from './types';

describe('Database types', () => {
  it('repos table has required fields', () => {
    type RepoRow = Database['public']['Tables']['repos']['Row'];
    expectTypeOf<RepoRow>().toHaveProperty('id');
    expectTypeOf<RepoRow>().toHaveProperty('owner');
    expectTypeOf<RepoRow>().toHaveProperty('enabled');
    expectTypeOf<RepoRow>().toHaveProperty('deleted_at');
  });
});
