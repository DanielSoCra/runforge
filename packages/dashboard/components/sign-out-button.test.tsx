import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignOutButton } from './sign-out-button';

describe('SignOutButton', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null)));
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('posts to the Better Auth sign-out endpoint and returns to login', async () => {
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'same-origin',
      });
    });
    expect(window.location.href).toBe('/login');
  });
});
