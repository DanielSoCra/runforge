vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/actions/github-connections', () => ({
  default: {},
  importRepos: vi.fn().mockResolvedValue(undefined),
  removeRepo: vi.fn().mockResolvedValue(undefined),
}));

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ImportReposModal, filterRepos } from './import-repos-modal';

const mockOrgs = [{ id: '1', login: 'myorg', name: 'My Org', avatar_url: null }];
const mockGhRepos = [
  { owner: 'myorg', name: 'new-app', full_name: 'myorg/new-app', private: false },
  { owner: 'myorg', name: 'existing', full_name: 'myorg/existing', private: true },
];
const importedRepos = [{ id: 'db-1', owner: 'myorg', name: 'existing', enabled: true }];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/orgs')) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockOrgs) });
    if (url.includes('/repos')) return Promise.resolve({ ok: true, json: () => Promise.resolve(mockGhRepos) });
    return Promise.resolve({ ok: false, json: () => Promise.resolve([]) });
  }));
});

describe('filterRepos', () => {
  it('hides imported repos when status is not_imported', () => {
    const imported = new Set(['myorg/existing']);
    const result = filterRepos(mockGhRepos, imported, '', 'all', 'not_imported');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('new-app');
  });

  it('shows all repos when status is all', () => {
    const imported = new Set(['myorg/existing']);
    const result = filterRepos(mockGhRepos, imported, '', 'all', 'all');
    expect(result).toHaveLength(2);
  });

  it('filters by search query', () => {
    const result = filterRepos(mockGhRepos, new Set(), 'new', 'all', 'all');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('new-app');
  });

  it('filters public repos', () => {
    const result = filterRepos(mockGhRepos, new Set(), '', 'public', 'all');
    expect(result).toHaveLength(1);
    expect(result[0].private).toBe(false);
  });

  it('filters private repos', () => {
    const result = filterRepos(mockGhRepos, new Set(), '', 'private', 'all');
    expect(result).toHaveLength(1);
    expect(result[0].private).toBe(true);
  });
});

describe('ImportReposModal', () => {
  it('renders the import button', () => {
    render(
      <ImportReposModal connectionId="conn-1" connectionName="My Connection" importedRepos={[]} />
    );
    expect(screen.getByRole('button', { name: /import repositories/i })).toBeInTheDocument();
  });

  it('opens dialog and loads orgs', async () => {
    render(
      <ImportReposModal connectionId="conn-1" connectionName="My Connection" importedRepos={[]} />
    );
    fireEvent.click(screen.getByRole('button', { name: /import repositories/i }));
    await waitFor(() => expect(screen.getByText('My Org')).toBeInTheDocument());
  });

  it('hides imported repos by default', async () => {
    render(
      <ImportReposModal connectionId="conn-1" connectionName="My Connection" importedRepos={importedRepos} />
    );
    fireEvent.click(screen.getByRole('button', { name: /import repositories/i }));
    await waitFor(() => expect(screen.getByText('new-app')).toBeInTheDocument());
    expect(screen.queryByText('existing')).not.toBeInTheDocument();
  });
});
