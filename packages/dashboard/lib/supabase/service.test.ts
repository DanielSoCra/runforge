import { describe, expect, it } from 'vitest';

import { createServiceClient } from './service';

describe('createServiceClient', () => {
  it('fails closed because dashboard service-role clients are retired', () => {
    expect(() => createServiceClient()).toThrow(
      'Dashboard service-role Supabase clients have been retired',
    );
  });
});
