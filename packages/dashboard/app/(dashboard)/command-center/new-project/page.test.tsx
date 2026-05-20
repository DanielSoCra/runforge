import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listOwnerOptions: vi.fn(),
}));

vi.mock('@/components/page-error', () => ({
  PageError: () => <div>Page error</div>,
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    githubConnections: {
      listOwnerOptions: mocks.listOwnerOptions,
    },
  }),
}));
vi.mock('./new-project-wizard', () => ({
  NewProjectWizard: ({ orgOptions }: { orgOptions: string[] }) => (
    <div>owners: {orgOptions.join(', ')}</div>
  ),
}));

beforeEach(() => {
  cleanup();
  mocks.listOwnerOptions.mockReset();
  mocks.listOwnerOptions.mockResolvedValue({
    ok: true,
    value: ['auto-claude', 'octocat'],
  });
});

describe('NewProjectPage', () => {
  it('renders owner options from the app-owned GitHub store', async () => {
    const { default: NewProjectPage } = await import('./page');

    render(await NewProjectPage());

    expect(screen.getByText('owners: auto-claude, octocat')).toBeInTheDocument();
    expect(mocks.listOwnerOptions).toHaveBeenCalledTimes(1);
  });

  it('shows the page error when GitHub owner options are unavailable', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.listOwnerOptions.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'connection refused',
    });
    const { default: NewProjectPage } = await import('./page');

    render(await NewProjectPage());

    expect(screen.getByText('Page error')).toBeInTheDocument();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[new-project] failed to load GitHub owner options:',
      'connection refused',
    );
    consoleSpy.mockRestore();
  });
});
