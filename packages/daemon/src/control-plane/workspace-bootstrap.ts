// packages/daemon/src/control-plane/workspace-bootstrap.ts
import { existsSync as nodeExistsSync } from 'node:fs';
import { mkdir as nodeMkdir, writeFile as nodeWriteFile } from 'node:fs/promises';
import { homedir as nodeHomedir } from 'node:os';
import { dirname, join } from 'node:path';
import { git as nodeGit } from '../lib/git.js';
import type { Config } from '../config.js';
import type { Result } from '../lib/result.js';

/**
 * Injectable side effects, so the resolution/clone decision tree is unit-testable
 * without touching a real git/filesystem.
 */
export interface BootstrapDeps {
  git: (args: string[], cwd?: string) => Promise<Result<string>>;
  existsSync: (p: string) => boolean;
  mkdir: (p: string, opts: { recursive: boolean }) => Promise<unknown>;
  writeFile: (p: string, data: string, opts: { mode: number }) => Promise<void>;
  env: Record<string, string | undefined>;
  cwd: () => string;
  homedir: () => string;
  log?: (msg: string) => void;
}

const defaultDeps: BootstrapDeps = {
  git: nodeGit,
  existsSync: nodeExistsSync,
  mkdir: (p, opts) => nodeMkdir(p, opts),
  writeFile: (p, data, opts) => nodeWriteFile(p, data, opts),
  env: process.env,
  cwd: () => process.cwd(),
  homedir: () => nodeHomedir(),
};

/**
 * Resolve the local `repoRoot` the pipeline worktrees branches off
 * (`git worktree add` needs a git repo to run from).
 *
 * Two modes, selected by whether the resolved dir is already a git checkout:
 *
 *  - **Native** (the historical contract): the daemon is launched from inside a
 *    checkout of the target repo, so `process.cwd()` (or `config.workspaceRoot`)
 *    is already a git repo → use it as-is. Byte-identical to the previous
 *    `const repoRoot = process.cwd()`.
 *
 *  - **Container / fresh host**: the resolved dir is NOT a git repo (e.g. the
 *    image's `/app/packages/daemon`, or an empty mounted volume) → clone the
 *    target repo into it so the worktree base exists. This is the gap that
 *    stuck every containerized run at the detect phase ("not a git repository").
 *
 * Auth: `runCommand` (lib/process.ts) runs git with a stripped env that drops
 * `GITHUB_TOKEN` but PRESERVES `HOME`. So the token can't ride in an env-based
 * credential helper — instead we write `$HOME/.git-credentials` (mode 600) and
 * enable the global `store` helper. That keeps the token out of the repo's
 * `.git/config`, authenticates the clone, and lets later fetch/push (post-gate
 * phases) reuse the same credential. The clone path only runs in the
 * non-git-repo (container) case, so native git config is never touched.
 */
export async function ensureWorkspaceRepo(
  config: Config,
  depsOverride?: Partial<BootstrapDeps>,
): Promise<string> {
  const deps: BootstrapDeps = { ...defaultDeps, ...depsOverride };
  const repoRoot = config.workspaceRoot ?? deps.cwd();
  const containerMode = config.workspaceRoot !== undefined;

  // Container mode: credentials live in $HOME, which does NOT survive a container
  // recreate, while the clone persists on a mounted volume. Re-establish git
  // credentials on EVERY boot (before the reuse/clone decision) or `git push`
  // silently breaks after the first restart (gap-8 / #43). Native mode leaves the
  // developer's global git config untouched.
  if (containerMode) {
    await ensureGitCredentials(deps);
  }

  if (await isGitRepo(repoRoot, deps)) {
    deps.log?.(
      `[workspace] repoRoot ${repoRoot} is a git checkout — using as-is`,
    );
    return repoRoot;
  }

  const repo = config.repo;
  if (!repo) {
    throw new Error(
      `[workspace] repoRoot ${repoRoot} is not a git checkout and config.repo is unset — set config.workspaceRoot to a writable empty path (container) or launch the daemon from inside a target checkout (native)`,
    );
  }
  const token = deps.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error(
      `[workspace] repoRoot ${repoRoot} is not a git checkout and GITHUB_TOKEN is not set — cannot clone ${repo.owner}/${repo.name}`,
    );
  }

  // Native fresh-clone needs credentials too (container already set them above).
  if (!containerMode) {
    await ensureGitCredentials(deps);
  }

  await deps.mkdir(dirname(repoRoot), { recursive: true });
  deps.log?.(
    `[workspace] repoRoot ${repoRoot} is not a git checkout — cloning ${repo.owner}/${repo.name}`,
  );
  const cloneUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
  const cloned = await deps.git(['clone', cloneUrl, repoRoot], dirname(repoRoot));
  if (!cloned.ok) {
    throw new Error(
      `[workspace] clone of ${repo.owner}/${repo.name} into ${repoRoot} failed: ${cloned.error.message}`,
    );
  }
  deps.log?.(`[workspace] cloned ${repo.owner}/${repo.name} into ${repoRoot}`);
  return repoRoot;
}

/**
 * Establish git credentials + safe.directory for the daemon's git operations.
 * Idempotent — safe to call on every boot. Keeps the token OUT of repo config: a
 * global credential `store` keyed on `$HOME/.git-credentials` (HOME is the one env
 * var that survives buildSafeEnv, which strips GITHUB_TOKEN from git subprocesses).
 * No-op when no token is present.
 */
async function ensureGitCredentials(deps: BootstrapDeps): Promise<void> {
  const token = deps.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') {
    deps.log?.('[workspace] GITHUB_TOKEN not set — skipping git credential setup');
    return;
  }
  await deps.writeFile(
    join(deps.homedir(), '.git-credentials'),
    `https://x-access-token:${token}@github.com\n`,
    { mode: 0o600 },
  );
  await deps.git(['config', '--global', 'credential.helper', 'store']);
  // safe.directory '*': container clones are root-owned on a mounted volume; this
  // silences git's dubious-ownership refusal for the repo and its worktrees.
  // Broad but acceptable for a single-tenant daemon container (documented
  // trade-off). --replace-all keeps it idempotent across boots (no dup entries).
  await deps.git(['config', '--global', '--replace-all', 'safe.directory', '*']);
}

async function isGitRepo(dir: string, deps: BootstrapDeps): Promise<boolean> {
  if (!deps.existsSync(dir)) return false;
  const probe = await deps.git(['rev-parse', '--git-dir'], dir);
  return probe.ok;
}
