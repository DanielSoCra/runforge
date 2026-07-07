import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the RUNFORGE_CONTROL_TOKEN value used by the daemon CLI to call
 * the control plane.
 *
 * Priority:
 * 1. `process.env.RUNFORGE_CONTROL_TOKEN` if set and non-empty.
 * 2. The `RUNFORGE_CONTROL_TOKEN` entry in the repo-root `.env.mac` file.
 * 3. `undefined` (the request goes tokenless; loopback /health still works).
 *
 * The repo root is located by walking up from this module file until we find a
 * `pnpm-workspace.yaml` or `.git` marker. This keeps CLI calls working no
 * matter what the current working directory is (e.g. `pnpm --filter` runs from
 * `packages/daemon`).
 */
export function resolveControlToken(): string | undefined {
  const envToken = process.env.RUNFORGE_CONTROL_TOKEN;
  if (envToken !== undefined && envToken !== '') return envToken;

  try {
    const envPath = resolve(resolveRepoRoot(), '.env.mac');
    const contents = readFileSync(envPath, 'utf-8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^RUNFORGE_CONTROL_TOKEN=(.+)$/);
      if (match) {
        const value = match[1]?.trim();
        if (value !== undefined && value.length > 0) return value;
      }
    }
  } catch {
    // .env.mac missing or unreadable — fine; /health works tokenless either way.
  }
  return undefined;
}

function resolveRepoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (current !== dirname(current)) {
    if (
      existsSync(resolve(current, 'pnpm-workspace.yaml')) ||
      existsSync(resolve(current, '.git'))
    ) {
      return current;
    }
    current = dirname(current);
  }
  return current;
}
