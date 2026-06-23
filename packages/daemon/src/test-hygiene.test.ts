// src/test-hygiene.test.ts
//
// Regression guard for the two concurrent-load flake patterns fixed in the
// ephemeral-ports (#757) and unique-temp-dirs (#758) PRs. The shared self-hosted
// runner runs multiple branch CIs + every package's `pnpm test` gate at once, so
// any test that grabs a *shared* OS resource by a fixed name collides across
// processes and flakes. This meta-test scans EVERY package's test sources and
// fails if either anti-pattern is reintroduced:
//
//   RC-1  A hard-coded TCP port bound by a real server (createControlServer /
//         createDegradedServer / .listen(<literal>)). Fixed ports collide ->
//         EADDRINUSE. Correct pattern: bind port 0, read server.address().port back.
//
//   RC-2  A temp path built from `${Date.now()}` under tmpdir(). Date.now() is not
//         unique across concurrent processes (same millisecond) -> path collision.
//         Correct pattern: mkdtemp(join(tmpdir(), 'prefix-')).
//
// Scope: the entire monorepo (every packages/**/*.test.ts). #757-759 proved the
// pattern on the daemon, but the shared self-hosted runner runs every package's
// tests concurrently, so the same fixed-name collision flakes any package — the
// guard belongs repo-wide, not just on the daemon. The check is a textual
// heuristic, not an AST pass, so it intentionally errs toward NOT flagging when a
// value is dynamic (a variable / port 0 / mkdtemp) and only fires on the concrete
// literal smells the original flaky tests used.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

// This guard lives in the daemon package but scans the WHOLE monorepo: from
// packages/daemon/src up two levels to packages/, then recurses every package.
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // packages/
const SELF = 'test-hygiene.test.ts';

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
      out.push(...listTestFiles(full));
    } else if (entry.name.endsWith('.test.ts') && entry.name !== SELF) {
      out.push(full);
    }
  }
  return out;
}

// Strip block + line comments so matches reflect real code, not prose or fixture
// strings. The `[^:]` guard before `//` avoids eating the `//` in URLs like http://.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// A fixed bind port is the smell; port 0 (one digit) is never matched by \d{2,5}.
const PORT_PATTERNS: RegExp[] = [
  /\b(?:createControlServer|createDegradedServer)\s*\(\s*(\d{2,5})\b/g,
  /\.listen\s*\(\s*(\d{2,5})\b/g,
  /\.listen\s*\(\s*\{\s*port\s*:\s*(\d{2,5})\b/g,
  /\bPORT\s*=\s*(\d{3,5})\b/g,
];
// tmpdir() followed soon after by ${Date.now()} == a Date.now-based temp path.
// The proximity window keeps innocent `new Date(Date.now() + …)` data usage (far
// from any tmpdir() call) from matching.
const TEMP_PATTERN = /tmpdir\(\)[\s\S]{0,160}?\$\{\s*Date\.now\(\)\s*\}/g;

export function findHygieneViolations(rawSrc: string, label: string): string[] {
  const src = stripComments(rawSrc);
  const violations: string[] = [];
  for (const re of PORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      violations.push(
        `${label}: fixed TCP port literal "${m[1]}" near "${m[0].trim()}" — bind port 0 and read server.address().port back instead.`,
      );
    }
  }
  TEMP_PATTERN.lastIndex = 0;
  let t: RegExpExecArray | null;
  while ((t = TEMP_PATTERN.exec(src)) !== null) {
    const snippet = t[0].replace(/\s+/g, ' ').slice(0, 80);
    violations.push(
      `${label}: \`\${Date.now()}\`-based temp path under tmpdir() near "${snippet}" — use mkdtemp(join(tmpdir(), 'prefix-')) for a process-unique dir instead.`,
    );
  }
  return violations;
}

// RC-3 (CI flake, 2026-06-23): several daemon tests re-import the large
// daemon.js module graph via loadDaemon() (vi.resetModules() + dynamic import).
// On the shared self-hosted runner the daemon's own `pnpm test` gate runs
// concurrently with branch CIs, and that cold esbuild transform/eval is starved
// well past the 5s default testTimeout, timing out the FIRST loadDaemon() test
// (passed 100% idle; failed 12/12 under 4x concurrent load). The fix raises
// testTimeout/hookTimeout in packages/daemon/vitest.config.ts; this guard locks
// that floor in so it cannot silently regress to the default.
//
// The check evaluates the *effective resolved config object* rather than
// string-matching the source: a regex over source would false-pass if
// `testTimeout`/`hookTimeout` appeared in a dead/unrelated object or a commented
// line. We assert the actual numeric values that Vitest will use.
export const MIN_CONTENTION_TIMEOUT_MS = 20_000;

type TimeoutConfig = { testTimeout?: number; hookTimeout?: number } | undefined;

export function findTimeoutHardeningViolations(testConfig: TimeoutConfig, label: string): string[] {
  const violations: string[] = [];
  for (const key of ['testTimeout', 'hookTimeout'] as const) {
    const value = testConfig?.[key];
    if (typeof value !== 'number') {
      violations.push(
        `${label}: missing numeric \`test.${key}\` — set it >= ${MIN_CONTENTION_TIMEOUT_MS}ms so the loadDaemon() cold dynamic import can't time out under shared-runner contention (RC-3).`,
      );
      continue;
    }
    if (!(value >= MIN_CONTENTION_TIMEOUT_MS)) {
      violations.push(
        `${label}: \`test.${key}\` is ${value}ms, below the ${MIN_CONTENTION_TIMEOUT_MS}ms contention floor (RC-3) — the daemon graph's cold dynamic import is starved past it under concurrent CI load.`,
      );
    }
  }
  return violations;
}

describe('test hygiene: no concurrent-load flake anti-patterns in any package tests', () => {
  it('binds no fixed TCP ports and builds no Date.now()-based temp paths', () => {
    const files = listTestFiles(PACKAGES_DIR);
    // Sanity: the scan actually found the monorepo test tree (guard isn't
    // vacuously empty). The daemon package alone has >200 test files.
    expect(files.length).toBeGreaterThan(100);
    const violations = files.flatMap((f) =>
      findHygieneViolations(readFileSync(f, 'utf8'), relative(PACKAGES_DIR, f)),
    );
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  it('detector actually fires on the anti-patterns (not a no-op)', () => {
    const bad = [
      'const PORT = 19876;',
      'const { server, start } = createControlServer(19876, handlers);',
      'server.listen(47821, host);',
      "const dir = join(tmpdir(), `test-hook-${Date.now()}.mjs`);",
    ].join('\n');
    const found = findHygieneViolations(bad, 'synthetic');
    // PORT=, createControlServer(literal), .listen(literal), and the temp path.
    expect(found.length).toBeGreaterThanOrEqual(4);

    const clean = [
      'const { server, start } = createControlServer(0, handlers);',
      'server.listen({ port: 0, host });',
      "const dir = mkdtempSync(join(tmpdir(), 'hook-'));",
      'const future = new Date(Date.now() + 604800000).toISOString();',
    ].join('\n');
    expect(findHygieneViolations(clean, 'synthetic-clean')).toEqual([]);
  });

  it('daemon vitest config keeps the RC-3 contention timeout floor', async () => {
    // Evaluate the REAL exported config (not a source string match): this fails
    // if the timeouts are removed, dropped below the floor, or moved out of the
    // effective `test:` block — the only states that actually reintroduce RC-3.
    // Imported via a variable path: the config lives outside the test rootDir
    // ('src') and is a .ts file, both of which a static import specifier would
    // trip tsc on (TS6059 / TS5097). A variable specifier defers resolution to
    // the runtime (Vitest), which resolves it fine.
    const configModulePath = '../vitest.config.ts';
    const mod = (await import(configModulePath)) as { default: unknown };
    const resolved =
      typeof mod.default === 'function'
        ? await (mod.default as (env: { mode: string; command: string }) => unknown)({
            mode: 'test',
            command: 'serve',
          })
        : mod.default;
    const testConfig = (resolved as { test?: TimeoutConfig }).test;
    const violations = findTimeoutHardeningViolations(testConfig, 'daemon/vitest.config.ts');
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  it('RC-3 detector fires on a missing or too-low timeout config (not a no-op)', () => {
    // No test block at all -> 2 violations.
    expect(findTimeoutHardeningViolations(undefined, 'no-test-block')).toHaveLength(2);
    // Test block present but timeouts absent -> 2 violations.
    expect(findTimeoutHardeningViolations({}, 'no-timeouts')).toHaveLength(2);
    // Present but below the floor (the 5s default that flaked) -> 2 violations.
    expect(
      findTimeoutHardeningViolations({ testTimeout: 5_000, hookTimeout: 5_000 }, 'too-low'),
    ).toHaveLength(2);
    // One ok, one too low -> 1 violation (the floor is per-key).
    expect(
      findTimeoutHardeningViolations({ testTimeout: 30_000, hookTimeout: 5_000 }, 'mixed'),
    ).toHaveLength(1);
    // Both at/above the floor -> clean.
    expect(
      findTimeoutHardeningViolations({ testTimeout: 30_000, hookTimeout: 30_000 }, 'ok'),
    ).toEqual([]);
  });
});
