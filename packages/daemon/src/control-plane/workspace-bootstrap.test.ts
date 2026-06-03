import { describe, it, expect, vi } from 'vitest';
import { ensureWorkspaceRepo, type BootstrapDeps } from './workspace-bootstrap.js';
import { ok, err, type Result } from '../lib/result.js';
import type { Config } from '../config.js';

const baseConfig = {
  repo: { owner: 'acme', name: 'widgets' },
} as unknown as Config;

/** Build deps with a programmable git stub that records its calls. */
function makeDeps(
  overrides: Partial<BootstrapDeps> & {
    gitImpl?: (args: string[], cwd?: string) => Result<string>;
  } = {},
): { deps: BootstrapDeps; gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  const gitImpl =
    overrides.gitImpl ?? ((_args: string[]) => ok(''));
  const deps: BootstrapDeps = {
    git: async (args, _cwd) => {
      gitCalls.push(args);
      return gitImpl(args, _cwd);
    },
    existsSync: () => true,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    env: { GITHUB_TOKEN: 'ghs_test' },
    cwd: () => '/work/checkout',
    homedir: () => '/home/daemon',
    log: () => {},
    ...overrides,
  };
  return { deps, gitCalls };
}

describe('ensureWorkspaceRepo', () => {
  it('native: cwd is already a git repo → returns it, never clones', async () => {
    // rev-parse --git-dir succeeds → it is a checkout.
    const { deps, gitCalls } = makeDeps({
      gitImpl: (args) =>
        args[0] === 'rev-parse' ? ok('.git') : ok(''),
    });
    const root = await ensureWorkspaceRepo(baseConfig, deps);
    expect(root).toBe('/work/checkout');
    expect(gitCalls.some((c) => c[0] === 'clone')).toBe(false);
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('container mode (workspaceRoot) re-establishes git credentials on EVERY boot, even when the clone is reused (#43 gap-8)', async () => {
    // reuse path: existsSync true + rev-parse ok → already a git checkout, NO clone.
    // $HOME is wiped on container recreate while the clone persists on a volume,
    // so credentials MUST be rewritten each boot or `git push` breaks on restart.
    const { deps, gitCalls } = makeDeps({
      gitImpl: (args) => (args[0] === 'rev-parse' ? ok('.git') : ok('')),
    });
    const cfg = { ...baseConfig, workspaceRoot: '/app/repo' } as Config;
    const root = await ensureWorkspaceRepo(cfg, deps);
    expect(root).toBe('/app/repo');
    expect(gitCalls.some((c) => c[0] === 'clone')).toBe(false); // reused, not cloned
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/home/daemon/.git-credentials',
      expect.stringContaining('x-access-token:ghs_test@github.com'),
      { mode: 0o600 },
    );
    expect(gitCalls).toContainEqual(['config', '--global', 'credential.helper', 'store']);
  });

  it('native reuse (no workspaceRoot) still never touches git credentials', async () => {
    const { deps, gitCalls } = makeDeps({
      gitImpl: (args) => (args[0] === 'rev-parse' ? ok('.git') : ok('')),
    });
    await ensureWorkspaceRepo(baseConfig, deps); // no workspaceRoot → native
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(gitCalls.some((c) => c[0] === 'config')).toBe(false);
  });

  it('config.workspaceRoot overrides cwd for the probe', async () => {
    const { deps } = makeDeps({
      gitImpl: (args) => (args[0] === 'rev-parse' ? ok('.git') : ok('')),
    });
    const cfg = { ...baseConfig, workspaceRoot: '/app/repo' } as Config;
    const root = await ensureWorkspaceRepo(cfg, deps);
    expect(root).toBe('/app/repo');
  });

  it('container: not a git repo → clones target into workspaceRoot with credential store', async () => {
    const { deps, gitCalls } = makeDeps({
      // rev-parse fails → not a checkout; everything else (config/clone) ok.
      gitImpl: (args) =>
        args[0] === 'rev-parse'
          ? err(new Error('fatal: not a git repository'))
          : ok(''),
    });
    const cfg = { ...baseConfig, workspaceRoot: '/app/repo' } as Config;
    const root = await ensureWorkspaceRepo(cfg, deps);

    expect(root).toBe('/app/repo');
    // wrote $HOME/.git-credentials (token out of repo config), mode 600
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/home/daemon/.git-credentials',
      expect.stringContaining('x-access-token:ghs_test@github.com'),
      { mode: 0o600 },
    );
    // enabled the store helper + cloned the clean (token-free) URL into the root
    expect(gitCalls).toContainEqual([
      'config',
      '--global',
      'credential.helper',
      'store',
    ]);
    const clone = gitCalls.find((c) => c[0] === 'clone');
    expect(clone).toEqual([
      'clone',
      'https://github.com/acme/widgets.git',
      '/app/repo',
    ]);
    // the clone URL must NOT carry the token (kept in the credential store only)
    expect(clone?.[1]).not.toContain('ghs_test');
  });

  it('container path requires a token → throws a clear error when GITHUB_TOKEN is unset', async () => {
    const { deps } = makeDeps({
      gitImpl: (args) =>
        args[0] === 'rev-parse'
          ? err(new Error('not a git repository'))
          : ok(''),
      env: {},
    });
    const cfg = { ...baseConfig, workspaceRoot: '/app/repo' } as Config;
    await expect(ensureWorkspaceRepo(cfg, deps)).rejects.toThrow(
      /GITHUB_TOKEN is not set/,
    );
  });

  it('container path requires config.repo → throws when repo is unset', async () => {
    const { deps } = makeDeps({
      gitImpl: (args) =>
        args[0] === 'rev-parse'
          ? err(new Error('not a git repository'))
          : ok(''),
    });
    const cfg = { workspaceRoot: '/app/repo' } as Config;
    await expect(ensureWorkspaceRepo(cfg, deps)).rejects.toThrow(
      /config\.repo is unset/,
    );
  });

  it('surfaces a clone failure as a thrown error (not a silent stuck)', async () => {
    const { deps } = makeDeps({
      gitImpl: (args) => {
        if (args[0] === 'rev-parse') return err(new Error('not a git repository'));
        if (args[0] === 'clone') return err(new Error('Repository not found'));
        return ok('');
      },
    });
    const cfg = { ...baseConfig, workspaceRoot: '/app/repo' } as Config;
    await expect(ensureWorkspaceRepo(cfg, deps)).rejects.toThrow(
      /clone of acme\/widgets .* failed: Repository not found/,
    );
  });
});
