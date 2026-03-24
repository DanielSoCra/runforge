import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { EnableAllForm } from './enable-all-form';

describe('EnableAllForm', () => {
  it('renders the Enable All button', () => {
    const action = vi.fn().mockResolvedValue({ succeeded: [], failed: [] });
    render(<EnableAllForm action={action} />);
    expect(screen.getByRole('button', { name: 'Enable All' })).toBeDefined();
  });

  it('displays succeeded and failed counts after submission (#352)', async () => {
    const action = vi.fn().mockResolvedValue({
      succeeded: ['web-stack', 'api-tools'],
      failed: ['db-tools'],
    });
    render(<EnableAllForm action={action} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable All' }));
    });

    expect(screen.getByText(/2 enabled/)).toBeDefined();
    expect(screen.getByText(/1 failed/)).toBeDefined();
    expect(screen.getByText(/db-tools/)).toBeDefined();
  });

  it('displays error message when action returns an error', async () => {
    const action = vi.fn().mockResolvedValue({
      succeeded: [],
      failed: [],
      error: 'Unauthorized',
    });
    render(<EnableAllForm action={action} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable All' }));
    });

    expect(screen.getByText('Unauthorized')).toBeDefined();
  });

  it('shows only succeeded when no failures', async () => {
    const action = vi.fn().mockResolvedValue({
      succeeded: ['web-stack'],
      failed: [],
    });
    render(<EnableAllForm action={action} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable All' }));
    });

    expect(screen.getByText(/1 enabled/)).toBeDefined();
    expect(screen.queryByText(/failed/)).toBeNull();
  });
});
