import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { updateSession } from './middleware';

function makeRequest(path: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'));
}

describe('updateSession compatibility shim', () => {
  it('returns a pass-through response without hosted auth refresh', async () => {
    const response = await updateSession(makeRequest('/dashboard'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});
