import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isDashboardAdmin: vi.fn(),
  readGlobalSettings: vi.fn(),
}));

vi.mock('@/actions/settings', () => ({ updateGlobalSettings: vi.fn() }));
vi.mock('@/components/page-error', () => ({
  PageError: () => <div>Error</div>,
}));
vi.mock('@/components/github-connections-section', () => ({
  GitHubConnectionsSection: () => <div>connections</div>,
}));
vi.mock('@/lib/auth/require-session', () => ({
  isDashboardAdmin: mocks.isDashboardAdmin,
}));
vi.mock('@/lib/data/stores', () => ({
  getDashboardStores: () => ({
    settings: {
      readGlobalSettings: mocks.readGlobalSettings,
    },
  }),
}));

beforeEach(() => {
  cleanup();
  mocks.isDashboardAdmin.mockReset();
  mocks.readGlobalSettings.mockReset();
  mocks.isDashboardAdmin.mockResolvedValue(true);
  mocks.readGlobalSettings.mockResolvedValue({
    ok: true,
    value: { id: 'settings-1', concurrencyLimit: 3 },
  });
});
describe('SettingsPage', () => {
  it('shows access denied for non-admin users', async () => {
    mocks.isDashboardAdmin.mockResolvedValue(false);
    const { default: SettingsPage } = await import('./page');
    const result = await SettingsPage();
    render(result);
    expect(
      screen.getByText('Admin access required to view settings.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Save Settings')).not.toBeInTheDocument();
    expect(mocks.readGlobalSettings).not.toHaveBeenCalled();
  });

  it('shows settings form for admin users from the app-owned settings store', async () => {
    const { default: SettingsPage } = await import('./page');
    const result = await SettingsPage();
    render(result);
    expect(screen.getByText('Save Settings')).toBeInTheDocument();
    expect(screen.getByLabelText('Max concurrent workers')).toHaveValue(3);
    expect(screen.getByText('connections')).toBeInTheDocument();
  });

  it('uses first-run defaults when the settings row is absent', async () => {
    mocks.readGlobalSettings.mockResolvedValueOnce({
      ok: false,
      error: 'not-found',
      message: 'global settings were not found',
    });
    const { default: SettingsPage } = await import('./page');
    const result = await SettingsPage();
    render(result);
    expect(screen.getByLabelText('Max concurrent workers')).toHaveValue(3);
  });

  it('shows the page error when the settings store is unavailable', async () => {
    mocks.readGlobalSettings.mockResolvedValueOnce({
      ok: false,
      error: 'unavailable',
      message: 'connection refused',
    });
    const { default: SettingsPage } = await import('./page');
    const result = await SettingsPage();
    render(result);
    expect(screen.getByText('Error')).toBeInTheDocument();
  });
});
