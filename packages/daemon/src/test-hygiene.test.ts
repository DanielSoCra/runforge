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
    } else if (
      (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) &&
      entry.name !== SELF
    ) {
      // .test.tsx is matched too: vitest collects it, so the repo-wide guard must
      // see it as well (the dashboard ships 29 .test.tsx files). A narrower scan
      // would let an anti-pattern in a .tsx test escape every check here.
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

// Blank out string-literal and comment CONTENT while PRESERVING line count (every '\n' stays),
// so brace-depth tracking ignores braces in strings/comments AND sanitized line indices stay
// aligned with the raw source. The existing stripComments folds a /* */ block to ONE space,
// which desyncs the indices and drifts the region scan (codex plan review). Char state machine.
function blankStringsAndComments(src: string): string {
  let out = '';
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let mode: Mode = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const c2 = src[i + 1];
    if (c === '\n') { out += '\n'; if (mode === 'line') mode = 'code'; continue; }
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { mode = 'line'; out += '  '; i++; continue; }
      if (c === '/' && c2 === '*') { mode = 'block'; out += '  '; i++; continue; }
      if (c === "'") { mode = 'sq'; out += ' '; continue; }
      if (c === '"') { mode = 'dq'; out += ' '; continue; }
      if (c === '`') { mode = 'tpl'; out += ' '; continue; }
      out += c; continue;
    }
    if (mode === 'line') { out += ' '; continue; }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') { mode = 'code'; out += '  '; i++; continue; }
      out += ' '; continue;
    }
    if (c === '\\') {
      if (c2 === '\n') { out += ' \n'; i++; continue; } // line-continuation: keep the newline
      out += '  '; i++; continue; // other escape: blank both chars
    }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = 'code'; out += ' '; continue;
    }
    out += ' ';
  }
  return out;
}

// RC-4 (CI flake, 2026-06-29/30): the real-Postgres resume tests bridge the faked poll loop
// and the real postgres-js writer with a settle helper. A FIXED-budget drain (settleRealAsync)
// is adequate at idle but overruns under shared-runner CPU contention, so a positive
// resume-completion assertion runs before the durable effect lands (the cockpit-consumer
// flake). The deterministic fix is settleRealUntil(predicate). This guard forbids a fixed
// drain inside any real-PG resume describe (describe.skipIf(!REAL_PG)) unless an explicit
// `fixed-drain-ok` marker documents a legitimate negative / non-advancement drain.
//
// Region + call are matched on the line-preserving sanitized copy (so braces or a
// `settleRealAsync` mention inside a string/comment never count). The `fixed-drain-ok` marker
// IS a comment, so it is matched on the RAW lines (sanitizing erases it); indices align because
// the sanitizer preserves line count.
export function findFixedDrainViolations(rawSrc: string, label: string): string[] {
  const rawLines = rawSrc.split('\n');
  const codeLines = blankStringsAndComments(rawSrc).split('\n');
  const violations: string[] = [];
  let inRealPg = false;
  let depth = 0;
  let sawBody = false;
  for (let i = 0; i < codeLines.length; i++) {
    const code = codeLines[i] ?? '';
    if (!inRealPg && /describe\s*\.\s*skipIf\s*\(\s*!\s*REAL_PG\s*\)/.test(code)) {
      inRealPg = true;
      depth = 0;
      sawBody = false;
    }
    if (!inRealPg) continue;
    for (const ch of code) {
      if (ch === '{') {
        depth++;
        sawBody = true;
      } else if (ch === '}') depth--;
    }
    if (/\bawait\s+settleRealAsync\s*\(/.test(code)) {
      const window = `${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}\n${rawLines[i + 1] ?? ''}`;
      if (!/fixed-drain-ok/.test(window)) {
        violations.push(
          `${label}:${i + 1}: settleRealAsync() inside a describe.skipIf(!REAL_PG) resume describe — a fixed wall-clock drain flakes under shared-runner contention (RC-4). Use settleRealUntil(predicate) to wait on the asserted resume effect, or add a \`// fixed-drain-ok: <reason>\` marker for a legitimate negative/non-advancement drain.`,
        );
      }
    }
    // Close the region only AFTER its body brace has opened — a describe whose `() => {`
    // body brace lands on a LATER line than the `describe.skipIf(!REAL_PG)(` opener must not
    // close immediately at depth 0 (codex deep-review minor).
    if (sawBody && depth <= 0) inRealPg = false; // describe block closed
  }
  return violations;
}

// RC-3 cold-import pattern detector — package-level signal: does this test source
// call vi.resetModules()? A test resets the module registry for exactly one reason:
// to force the NEXT dynamic import() to re-evaluate cold. Under shared-runner
// contention that cold esbuild transform/eval is CPU-starved and can blow the 5s
// default timeout (the daemon's loadDaemon() flake — #770). So ANY package whose
// tests do this needs the contention-timeout floor below, not just the daemon.
//
// We key on resetModules() ALONE (not "resetModules AND import() in the same file")
// on purpose: the re-import it forces may live in a sibling test or a shared test
// helper, not the same source — a same-file-only match would let that escape (codex
// review, 2026-06-24). resetModules() is the unambiguous, co-located signal of the
// re-import intent, so its mere presence in a package's tests flags the package.
//
// Deliberately errs toward INCLUSION: a needless floor is harmless — a higher
// timeout only delays the failure of a genuinely-hung test, it never breaks a
// passing one — whereas a MISSED floor is exactly the RC-3 bug. (Today only daemon
// + dashboard call resetModules().) Comments are stripped first, so a commented-out
// or prose mention does not count.
export function mentionsModuleReset(rawSrc: string): boolean {
  return /\bresetModules\s*\(/.test(stripComments(rawSrc));
}

// RC-5 (CI flake, 2026-07-03): the real-Postgres replay tests drive a second poll
// tick to verify idempotency. A single `advanceTimersByTimeAsync(pollPeriod)` followed
// by a passive `settleRealUntil()` hangs under load because the second interval fire
// can be swallowed: `RepoManager.startPoll` guards re-entrancy with `pollInProgress`,
// and #839 added a per-run in-flight guard to `resumeParkedRuns`. If tick2 lands while
// tick1 is still draining, it is lost and never re-fired. The deterministic fix is
// `advancePollsUntil()`, which re-arms the faked interval until the effect appears.
//
// This guard forbids a passive `settleRealUntil()` after a second-or-later non-zero
// `vi.advanceTimersByTimeAsync()` fire inside any `it()` body within a
// `describe.skipIf(!REAL_PG)` region. `advanceTimersByTimeAsync(0)` is treated as a
// microtask flush belonging to the preceding fire and does NOT count as a new fire.
// A `// second-tick-ok: <reason>` marker inside the `it()` body documents a legitimate
// negative (e.g. a predicate satisfiable by tick1's effect alone).
//
// Region + calls are matched on the line-preserving sanitized copy; the marker is a
// comment, so it is matched on the RAW lines (sanitizing erases it). Indices align
// because the sanitizer preserves line count.
export function findSecondTickPassiveWaitViolations(rawSrc: string, label: string): string[] {
  const rawLines = rawSrc.split('\n');
  const codeLines = blankStringsAndComments(rawSrc).split('\n');
  const violations: string[] = [];
  let inRealPg = false;
  let regionDepth = 0;
  let regionSawBody = false;

  let itBodyDepth = 0;
  let itAwaitingBrace = false;
  let itStartLine = -1;
  let itFireCount = 0;
  let itDanger = false;
  const pending: { line: number; msg: string }[] = [];

  // A non-zero fire is any `vi.advanceTimersByTimeAsync(<arg>)` whose argument
  // text is NOT exactly `0`. `advanceTimersByTimeAsync(0)` is a microtask flush
  // and must not count as a poll fire. If the call argument spans lines, we do
  // a bounded look-ahead across the next 5 sanitized lines for the closing
  // paren; only the joined argument text exactly `0` is treated as a flush.
  // Still-unclosed calls remain conservatively classified as fires — the
  // `second-tick-ok:` marker remains the escape hatch.
  const advanceTimersCall = /\bvi\s*\.\s*advanceTimersByTimeAsync\s*\(/;
  const fullAdvanceTimersCall = /\bvi\s*\.\s*advanceTimersByTimeAsync\s*\(\s*([^)]*?)\s*\)/;
  const MULTILINE_LOOKAHEAD = 5;
  const advancePolls = /\badvancePollsUntil\s*\(/;
  const settleReal = /\bsettleRealUntil\s*\(/;
  const itStart = /(?<![\w.])it\s*\(/;

  function extractArgText(line: string, idx: number): string | undefined {
    const openMatch = advanceTimersCall.exec(line);
    if (!openMatch) return undefined;
    let afterOpen = line.slice(openMatch.index + openMatch[0].length);
    if (afterOpen.includes(')')) {
      const fullMatch = fullAdvanceTimersCall.exec(line);
      return fullMatch ? fullMatch[1]!.trim() : undefined;
    }
    for (let offset = 1; offset <= MULTILINE_LOOKAHEAD; offset++) {
      const nextLine = codeLines[idx + offset];
      if (nextLine === undefined) break;
      afterOpen += nextLine;
      if (nextLine.includes(')')) {
        const closeIdx = afterOpen.indexOf(')');
        return afterOpen.slice(0, closeIdx).trim();
      }
    }
    return undefined;
  }

  function isNonzeroFire(line: string, idx: number): boolean {
    if (!advanceTimersCall.test(line)) return false;
    const arg = extractArgText(line, idx);
    return arg === undefined ? true : arg !== '0';
  }

  for (let i = 0; i < codeLines.length; i++) {
    const code = codeLines[i] ?? '';

    if (!inRealPg && /describe\s*\.\s*skipIf\s*\(\s*!\s*REAL_PG\s*\)/.test(code)) {
      inRealPg = true;
      regionDepth = 0;
      regionSawBody = false;
    }

    if (inRealPg && itBodyDepth === 0 && !itAwaitingBrace && regionDepth > 0 && itStart.test(code)) {
      itAwaitingBrace = true;
      itStartLine = i;
      itFireCount = 0;
      itDanger = false;
      pending.length = 0;
    }

    if (inRealPg) {
      for (const ch of code) {
        if (ch === '{') {
          regionDepth++;
          regionSawBody = true;
          if (itAwaitingBrace) {
            itBodyDepth = 1;
            itAwaitingBrace = false;
          } else if (itBodyDepth > 0) {
            itBodyDepth++;
          }
        } else if (ch === '}') {
          regionDepth--;
          if (itBodyDepth > 0) {
            itBodyDepth--;
            if (itBodyDepth === 0) {
              const bodyRaw = rawLines.slice(itStartLine, i + 1).join('\n');
              if (!/second-tick-ok:/.test(bodyRaw)) {
                violations.push(...pending.map((p) => p.msg));
              }
              pending.length = 0;
              itFireCount = 0;
              itDanger = false;
              itStartLine = -1;
            }
          }
        }
      }
    }

    if (inRealPg && itBodyDepth > 0) {
      if (isNonzeroFire(code, i)) {
        itFireCount++;
        if (itFireCount >= 2) {
          itDanger = true;
        }
      } else if (advancePolls.test(code)) {
        itDanger = false;
      } else if (settleReal.test(code) && itDanger) {
        pending.push({
          line: i,
          msg: `${label}:${i + 1}: settleRealUntil() after a second-or-later poll tick inside a real-PG it() — a passive wait loses a swallowed tick2 under load (RepoManager.pollInProgress or #839 per-run guard). Use advancePollsUntil() to re-fire the interval, or add a \`// second-tick-ok: <reason>\` marker inside this it().`,
        });
      }
    }

    if (inRealPg && regionSawBody && regionDepth <= 0) {
      inRealPg = false;
    }
  }

  return violations;
}

// The package a monorepo test file belongs to = the first path segment under
// packages/. Each package keeps its vitest.config.ts at its own root.
function packageNameOf(absTestFile: string): string {
  return relative(PACKAGES_DIR, absTestFile).split(/[\\/]/)[0] ?? '';
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
// The check evaluates the *exported config object* (defineConfig({ test }))
// rather than string-matching the source: a regex over source would false-pass if
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

  it('every package whose tests use the RC-3 cold-import pattern keeps the contention timeout floor', async () => {
    // Generalized from a daemon-only check: the shared self-hosted runner runs
    // every package's tests concurrently, so the cold-import starvation flakes any
    // package that uses the pattern, not just the daemon. Detect the flagged
    // packages from their test sources, then assert each one's REAL config (not a
    // source string-match) holds the floor.
    const files = listTestFiles(PACKAGES_DIR);
    const flagged = new Set<string>();
    for (const f of files) {
      if (mentionsModuleReset(readFileSync(f, 'utf8'))) flagged.add(packageNameOf(f));
    }

    // Soft non-vacuous guard: while ANY package resets modules in its tests this
    // holds, catching a detector that silently matches nothing on the real tree.
    // Intentionally NOT asserting specific package names (daemon/dashboard) — that
    // would fail CI if a package legitimately drops the pattern even though no floor
    // is then required (codex review, 2026-06-24). The synthetic detector self-test
    // below is what proves the matcher actually fires. If the whole monorepo ever
    // stops resetting modules, delete this line.
    expect(flagged.size, 'module-reset detector found no packages — it likely broke').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const pkg of [...flagged].sort()) {
      // Variable specifier (not a static literal): the configs live outside this
      // test's rootDir ('src') and are .ts, both of which a static import would
      // trip tsc on (TS6059 / TS5097). A computed path defers resolution to Vitest.
      const configPath = join(PACKAGES_DIR, pkg, 'vitest.config.ts');
      let testConfig: TimeoutConfig;
      try {
        const mod = (await import(configPath)) as { default: unknown };
        const resolved =
          typeof mod.default === 'function'
            ? await (mod.default as (env: { mode: string; command: string }) => unknown)({
                mode: 'test',
                command: 'serve',
              })
            : mod.default;
        testConfig = (resolved as { test?: TimeoutConfig }).test;
      } catch (err) {
        // Fail-closed: a config we cannot evaluate cannot be PROVEN to hold the
        // floor, and a flagged package without an enforceable floor is the exact
        // RC-3 risk. No weak textual fallback — that would false-pass on a
        // commented / dead-object / spread-overridden / below-floor timeout.
        violations.push(
          `${pkg}/vitest.config.ts: could not be evaluated to verify the RC-3 contention floor (${
            (err as Error).message.split('\n')[0]
          }) — its tests use vi.resetModules()+import(), so it MUST set test.testTimeout/hookTimeout >= ${MIN_CONTENTION_TIMEOUT_MS}ms in a statically-evaluable config.`,
        );
        continue;
      }
      violations.push(...findTimeoutHardeningViolations(testConfig, `${pkg}/vitest.config.ts`));
    }
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });

  it('RC-3 module-reset detector fires on resetModules() and not otherwise', () => {
    // The re-import that resetModules() forces may be co-located, in a sibling test,
    // or in a shared helper — so the detector keys on resetModules() alone.
    expect(mentionsModuleReset('vi.resetModules();\nconst { x } = await import("./mod.js");')).toBe(true);
    expect(mentionsModuleReset('vi.resetModules();')).toBe(true); // reset present even with no same-file import
    expect(mentionsModuleReset('beforeEach(() => { vi.resetModules(); });')).toBe(true);
    // no module reset -> no cold re-eval, no floor needed.
    expect(mentionsModuleReset('const { x } = await import("./mod.js");')).toBe(false);
    expect(mentionsModuleReset('import foo from "./mod.js";')).toBe(false);
    // commented-out / prose mention must not count (comments are stripped first).
    expect(mentionsModuleReset('// vi.resetModules();')).toBe(false);
    expect(mentionsModuleReset('/* call vi.resetModules() here */')).toBe(false);
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

  it('RC-4: forbids fixed-budget settleRealAsync in real-PG resume describes (and the real file is clean)', () => {
    // Fires on a fixed drain inside a skipIf(!REAL_PG) describe with no marker.
    const bad = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "ok" });',
      '    await settleRealAsync();',
      "    expect(await m.ledger().statusOf(id)).toBe('resumed');",
      '  });',
      '});',
    ].join('\n');
    expect(findFixedDrainViolations(bad, 'synthetic-bad').length).toBe(1);

    // Passes when the drain carries a fixed-drain-ok marker.
    const marked = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    // fixed-drain-ok: negative — stays parked',
      '    await settleRealAsync();',
      "    expect(await m.ledger().statusOf(id)).toBe('notified');",
      '  });',
      '});',
    ].join('\n');
    expect(findFixedDrainViolations(marked, 'synthetic-marked')).toEqual([]);

    // Passes when the drain is OUTSIDE a real-PG describe (plain describe).
    const plain = [
      "describe('fake', () => {",
      '  it("y", async () => { await settleRealAsync(); });',
      '});',
    ].join('\n');
    expect(findFixedDrainViolations(plain, 'synthetic-plain')).toEqual([]);

    // Line-stability: a MULTI-LINE block comment before/inside the real-PG describe must not
    // shift indices or close the region early — an unmarked trailing drain still fires
    // (regression guard for the collapse-to-one-line desync, codex plan review).
    const withBlockComment = [
      '/* a multi-line',
      '   block comment',
      '   before the describe { with a brace } in prose */',
      "describe.skipIf(!REAL_PG)('x', () => {",
      '  /* inner block',
      '     comment */',
      "  it('y', async () => {",
      '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "ok" });',
      '    await settleRealAsync();', // unmarked trailing drain, near the region tail
      "    expect(await m.ledger().statusOf(id)).toBe('resumed');",
      '  });',
      '});',
    ].join('\n');
    expect(findFixedDrainViolations(withBlockComment, 'synthetic-block').length).toBe(1);

    // Multi-line describe opener: the `() => {` body brace lands on the line AFTER the
    // `describe.skipIf(!REAL_PG)(` opener. The region must NOT close at depth 0 before the
    // body brace opens, or the unmarked drain escapes (codex deep-review minor).
    const multilineOpener = [
      'describe.skipIf(!REAL_PG)(',
      "  'x',",
      '  () => {',
      "    it('y', async () => {",
      '      await settleRealAsync();',
      "      expect(await m.ledger().statusOf(id)).toBe('resumed');",
      '    });',
      '  },',
      ');',
    ].join('\n');
    expect(findFixedDrainViolations(multilineOpener, 'synthetic-multiline').length).toBe(1);

    // The REAL daemon test file is clean after migration.
    const daemonTest = join(PACKAGES_DIR, 'daemon', 'src', 'control-plane', 'daemon.test.ts');
    expect(
      findFixedDrainViolations(readFileSync(daemonTest, 'utf8'), 'daemon.test.ts'),
      'daemon.test.ts still has an unmarked fixed-budget settleRealAsync in a real-PG resume describe',
    ).toEqual([]);
  });

  it('RC-5: forbids passive second-tick waits in real-PG it() bodies (repo-wide + synthetic + real file)', () => {
    // Old flaky shape: two non-zero fires and then a passive settleRealUntil.
    const bad = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    await vi.advanceTimersByTimeAsync(30000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "tick1" });',
      '    const seen = answerSpy.mock.calls.length;',
      '    await vi.advanceTimersByTimeAsync(30000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => answerSpy.mock.calls.length, (n) => n > seen, { label: "tick2" });',
      '  });',
      '});',
    ].join('\n');
    expect(findSecondTickPassiveWaitViolations(bad, 'synthetic-bad').length).toBe(1);

    // Variable poll-period argument also counts as a fire.
    const badVariable = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    const pollPeriodMs = 30000;',
      '    await vi.advanceTimersByTimeAsync(pollPeriodMs);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "tick1" });',
      '    const seen = answerSpy.mock.calls.length;',
      '    await vi.advanceTimersByTimeAsync(pollPeriodMs);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => answerSpy.mock.calls.length, (n) => n > seen, { label: "tick2" });',
      '  });',
      '});',
    ].join('\n');
    expect(findSecondTickPassiveWaitViolations(badVariable, 'synthetic-bad-variable').length).toBe(1);

    // Underscore-separated numeric literal also counts as a fire.
    const badUnderscore = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    await vi.advanceTimersByTimeAsync(30_000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "tick1" });',
      '    const seen = answerSpy.mock.calls.length;',
      '    await vi.advanceTimersByTimeAsync(30_000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => answerSpy.mock.calls.length, (n) => n > seen, { label: "tick2" });',
      '  });',
      '});',
    ].join('\n');
    expect(findSecondTickPassiveWaitViolations(badUnderscore, 'synthetic-bad-underscore').length).toBe(1);

    // Split-line zero flush after one non-zero fire is still just tick1 + settle.
    const splitZeroClean = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    await vi.advanceTimersByTimeAsync(30000);',
      '    await vi.advanceTimersByTimeAsync(',
      '      0',
      '    );',
      '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "tick1" });',
      '  });',
      '});',
    ].join('\n');
    expect(findSecondTickPassiveWaitViolations(splitZeroClean, 'synthetic-split-zero-clean')).toEqual([]);

    // Split-line non-zero fire in second position + passive settle still fires.
    const splitNonZeroBad = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    await vi.advanceTimersByTimeAsync(30000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "tick1" });',
      '    const seen = answerSpy.mock.calls.length;',
      '    await vi.advanceTimersByTimeAsync(',
      '      30000',
      '    );',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => answerSpy.mock.calls.length, (n) => n > seen, { label: "tick2" });',
      '  });',
      '});',
    ].join('\n');
    expect(findSecondTickPassiveWaitViolations(splitNonZeroBad, 'synthetic-split-nonzero-bad').length).toBe(1);

    // advanceTimersByTimeAsync(0) is a microtask flush, not a fire, even as the second call.
    const zeroOnly = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => true, Boolean, { label: "x" });',
      '  });',
      '});',
    ].join('\n');
    expect(findSecondTickPassiveWaitViolations(zeroOnly, 'synthetic-zero-only')).toEqual([]);

    // One non-zero fire followed by (0) flushes + settle is the legitimate tick1 shape.
    const cleanTick1 = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    await vi.advanceTimersByTimeAsync(30000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "tick1" });',
      '  });',
      '});',
    ].join('\n');
    expect(findSecondTickPassiveWaitViolations(cleanTick1, 'synthetic-clean')).toEqual([]);

    // Marked with second-tick-ok: escapes.
    const marked = [
      "describe.skipIf(!REAL_PG)('x', () => {",
      "  it('y', async () => {",
      '    // second-tick-ok: predicate is satisfiable by tick1 effect alone',
      '    await vi.advanceTimersByTimeAsync(30000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => reenteredPipeline(100), Boolean, { label: "tick1" });',
      '    const seen = answerSpy.mock.calls.length;',
      '    await vi.advanceTimersByTimeAsync(30000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => answerSpy.mock.calls.length, (n) => n > seen, { label: "tick2" });',
      '  });',
      '});',
    ].join('\n');
    expect(findSecondTickPassiveWaitViolations(marked, 'synthetic-marked')).toEqual([]);

    // Same shape outside a real-PG describe is ignored.
    const plain = [
      "describe('fake', () => {",
      "  it('y', async () => {",
      '    await vi.advanceTimersByTimeAsync(30000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => true, Boolean, { label: "x" });',
      '    const seen = 0;',
      '    await vi.advanceTimersByTimeAsync(30000);',
      '    await vi.advanceTimersByTimeAsync(0);',
      '    await settleRealUntil(() => seen, (n) => n > 0, { label: "y" });',
      '  });',
      '});',
    ].join('\n');
    expect(findSecondTickPassiveWaitViolations(plain, 'synthetic-plain')).toEqual([]);

    // Repo-wide sweep: no other test file contains the old shape.
    const files = listTestFiles(PACKAGES_DIR);
    const repoViolations = files.flatMap((f) =>
      findSecondTickPassiveWaitViolations(readFileSync(f, 'utf8'), relative(PACKAGES_DIR, f)),
    );
    expect(repoViolations, `\n${repoViolations.join('\n')}\n`).toEqual([]);

    // The converted daemon test file is clean and carries no escape markers.
    const daemonTest = join(PACKAGES_DIR, 'daemon', 'src', 'control-plane', 'daemon.test.ts');
    const daemonSrc = readFileSync(daemonTest, 'utf8');
    expect(
      findSecondTickPassiveWaitViolations(daemonSrc, 'daemon.test.ts'),
      'daemon.test.ts still has a passive second-tick wait in a real-PG it()',
    ).toEqual([]);
    const markerCount = (daemonSrc.match(/second-tick-ok/g) ?? []).length;
    expect(markerCount, 'daemon.test.ts should need no second-tick-ok markers').toBe(0);
  });
});
