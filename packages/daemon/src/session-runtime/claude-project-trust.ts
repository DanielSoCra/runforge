// src/session-runtime/claude-project-trust.ts
//
// Root-safe workspace-trust seeding for autonomous, containerized Claude Code
// runs. The Claude CLI refuses to operate in an "untrusted workspace" until the
// interactive trust dialog is accepted — it tracks that per project path in
// $HOME/.claude.json (`projects[<absPath>].hasTrustDialogAccepted`). In a
// container the daemon's cwd and the dynamic worker worktrees are never
// trusted, so every `claude` invocation fails with "Workspace not trusted".
//
// `--dangerously-skip-permissions` is the documented bypass, but the CLI
// REFUSES it under root/sudo — and the daemon image runs as root. Seeding the
// per-project trust entry is the root-safe equivalent: it clears the trust gate
// without disabling the daemon's PreToolUse containment hooks (the real
// boundary), which still fire on every tool call.
//
// We only ever seed paths the daemon itself owns/created (its own cwd + the
// worktrees it spawns under WORKTREE_DIR). We refuse non-absolute paths so an
// ambiguous cwd can never be auto-trusted.
import { readFile, writeFile, rename, mkdir, rm } from 'fs/promises';
import { isAbsolute, join, dirname } from 'path';
import { homedir } from 'os';

export interface SeedTrustOptions {
  /** Override $HOME for tests. Defaults to process.env.HOME ?? os.homedir(). */
  home?: string;
}

interface ProjectEntry {
  hasTrustDialogAccepted?: boolean;
  hasCompletedProjectOnboarding?: boolean;
  [k: string]: unknown;
}

interface ClaudeConfig {
  hasCompletedOnboarding?: boolean;
  projects?: Record<string, ProjectEntry>;
  [k: string]: unknown;
}

function resolveHome(opts?: SeedTrustOptions): string {
  return opts?.home ?? process.env['HOME'] ?? homedir();
}

/**
 * Idempotently mark `projectPath` as a trusted Claude Code project in
 * $HOME/.claude.json, preserving every other key and project entry. Also sets
 * the top-level onboarding flag so the CLI does not block on first-run setup.
 * Atomic (write-to-temp + rename) so a concurrent CLI read never sees a partial
 * file.
 *
 * @throws if projectPath is not absolute.
 */
export async function seedClaudeProjectTrust(
  projectPath: string,
  opts?: SeedTrustOptions,
): Promise<void> {
  if (!isAbsolute(projectPath)) {
    throw new Error(
      `seedClaudeProjectTrust: refusing to trust non-absolute path "${projectPath}"`,
    );
  }
  const home = resolveHome(opts);
  const configPath = join(home, '.claude.json');

  let config: ClaudeConfig = {};
  try {
    config = JSON.parse(await readFile(configPath, 'utf-8')) as ClaudeConfig;
    if (typeof config !== 'object' || config === null) config = {};
  } catch {
    // Missing or unparseable — start fresh. (Operators may mount a real
    // .claude.json; if it's corrupt we still want the daemon to boot trusted.)
    config = {};
  }

  config.hasCompletedOnboarding = true;
  const projects = config.projects ?? {};
  const existing = projects[projectPath] ?? {};
  projects[projectPath] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  config.projects = projects;

  await mkdir(dirname(configPath), { recursive: true });
  const serialized = JSON.stringify(config, null, 2);

  // Prefer atomic write-temp + rename so a concurrent CLI read never sees a
  // partial file. BUT $HOME/.claude.json is frequently a Docker BIND MOUNT (a
  // single mounted file) — you cannot rename() over a bind-mount target on
  // Linux (EBUSY), and a cross-device temp would give EXDEV. Fall back to an
  // in-place write in those cases. The window is tiny and the CLI re-reads on
  // its own startup, so non-atomicity here is acceptable.
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, serialized, { mode: 0o600 });
    await rename(tmpPath, configPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'EBUSY' || code === 'EXDEV' || code === 'ENOTSUP') {
      try {
        await rm(tmpPath, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
      await writeFile(configPath, serialized, { mode: 0o600 });
    } else {
      throw e;
    }
  }
}
