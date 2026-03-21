// src/session-runtime/adapters/cli.ts
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ok, err, type Result } from '../../lib/result.js';
import type { AgentDefinition, SessionContext, SessionResult, ExitStatus, PitfallMarker } from '../../types.js';
import type { ContainmentPolicy } from '../containment-hooks.js';
import type { ProviderAdapter } from './types.js';
import { generateContainmentScript } from '../generate-containment-script.js';
import { generateTimeoutHookScript } from '../timeout-hook-script.js';
import { SessionError } from '../session-error.js';

export class CliAdapter implements ProviderAdapter {
  buildArgs(def: AgentDefinition, prompt: string, jsonSchema?: string): string[] {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(def.maxTurns),
    ];
    if (def.allowedTools.length > 0) {
      args.push('--allowedTools', def.allowedTools.join(','));
    }
    if (jsonSchema) {
      args.push('--json-schema', jsonSchema);
    }
    return args;
  }

  buildEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'dumb',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    };
    // Claude CLI auth: API key mode OR subscription mode (needs ~/.claude/ access)
    // Pass through auth-related vars. HOME gives access to ~/.claude/ for subscription auth.
    const passthrough = [
      'ANTHROPIC_API_KEY',  // API key auth
      'TMPDIR',             // temp directory
      'USER',               // needed by some CLI tools
      'SHELL',              // needed by Bash tool
      'XDG_CONFIG_HOME',    // alt config location
      'XDG_DATA_HOME',      // alt data location
      'NODE_EXTRA_CA_CERTS', // custom CA certs
    ];
    for (const key of passthrough) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (extra) Object.assign(env, extra);
    return env;
  }

  parseOutput(stdout: string): Result<{ output: string; cost: number; structuredData: unknown }> {
    try {
      const json = JSON.parse(stdout) as Record<string, unknown>;
      const output = typeof json['result'] === 'string'
        ? json['result']
        : typeof json['output'] === 'string'
          ? json['output']
          : JSON.stringify(json);
      const cost = typeof json['cost_usd'] === 'number'
        ? json['cost_usd']
        : typeof json['cost'] === 'number'
          ? json['cost']
          : 0;
      return ok({
        output,
        cost,
        structuredData: json,
      });
    } catch {
      // Non-JSON output — treat as plain text
      return ok({
        output: stdout.trim(),
        cost: 0,
        structuredData: null,
      });
    }
  }

  /**
   * Set up PreToolUse hooks (containment + timeout) in the workspace's .claude/ directory.
   * Returns paths to clean up after the session exits.
   */
  setupHooks(
    cwd: string,
    policy: ContainmentPolicy | undefined,
    timeoutMs: number,
    sessionStartTime?: number,
  ): { scriptPaths: string[]; settingsPath: string; markerPath?: string } {
    const now = sessionStartTime ?? Date.now();
    const scriptPaths: string[] = [];
    const preToolUseHooks: { matcher: string; hooks: { type: string; command: string }[] }[] = [];

    // Containment hook — only when a policy is provided
    if (policy) {
      const containmentPath = join(tmpdir(), `containment-hook-${process.pid}-${now}.mjs`);
      writeFileSync(containmentPath, generateContainmentScript(policy), { mode: 0o755 });
      scriptPaths.push(containmentPath);
      preToolUseHooks.push({
        matcher: '',
        hooks: [{ type: 'command', command: `node "${containmentPath}"` }],
      });
    }

    // Timeout hook — always installed when cwd is available
    const timeoutPath = join(tmpdir(), `timeout-hook-${process.pid}-${now}.mjs`);
    writeFileSync(timeoutPath, generateTimeoutHookScript(), { mode: 0o755 });
    scriptPaths.push(timeoutPath);
    preToolUseHooks.push({
      matcher: '',
      hooks: [{ type: 'command', command: `node "${timeoutPath}"` }],
    });

    // Marker file path for one-shot timeout detection cleanup
    const markerPath = join(tmpdir(), `timeout-warned-${now}.marker`);

    // Write .claude/settings.local.json with PreToolUse hooks
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.local.json');

    // Merge with existing settings if present
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* start fresh */ }
    }
    settings.hooks = {
      ...(settings.hooks as Record<string, unknown> ?? {}),
      PreToolUse: preToolUseHooks,
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    return { scriptPaths, settingsPath, markerPath };
  }

  cleanupHooks(paths: { scriptPaths: string[]; settingsPath: string; markerPath?: string }): void {
    for (const p of paths.scriptPaths) {
      try { unlinkSync(p); } catch { /* already cleaned */ }
    }
    if (paths.markerPath) {
      try { unlinkSync(paths.markerPath); } catch { /* may not exist */ }
    }
    // Remove only our hooks from settings — restore previous state
    try {
      const content = readFileSync(paths.settingsPath, 'utf8');
      const settings = JSON.parse(content) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, unknown> | undefined;
      if (hooks) {
        delete hooks.PreToolUse;
        if (Object.keys(hooks).length === 0) delete settings.hooks;
      }
      if (Object.keys(settings).length === 0) {
        unlinkSync(paths.settingsPath);
      } else {
        writeFileSync(paths.settingsPath, JSON.stringify(settings, null, 2));
      }
    } catch { /* best-effort cleanup */ }
  }

  async spawn(
    def: AgentDefinition,
    prompt: string,
    options?: { cwd?: string; jsonSchema?: string; containmentPolicy?: ContainmentPolicy },
  ): Promise<Result<SessionResult>> {
    const args = this.buildArgs(def, prompt, options?.jsonSchema);
    const sessionStartTime = Date.now();
    const extraEnv: Record<string, string> = {
      SESSION_START_TIME: String(sessionStartTime),
      SESSION_TIMEOUT_MS: String(def.timeoutMs),
    };
    const env = this.buildEnv(extraEnv);

    // Set up hooks whenever cwd is known — timeout hooks are always needed,
    // containment hooks only when a policy is provided
    let hookPaths: { scriptPaths: string[]; settingsPath: string; markerPath?: string } | undefined;
    if (options?.cwd) {
      hookPaths = this.setupHooks(options.cwd, options.containmentPolicy, def.timeoutMs, sessionStartTime);
    }

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const proc = spawn('claude', args, {
        cwd: options?.cwd,
        env,
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, def.timeoutMs);

      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d));

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (hookPaths) this.cleanupHooks(hookPaths);
        const stdout = Buffer.concat(chunks).toString();
        const stderr = Buffer.concat(errChunks).toString();

        // Detect rate limit signals in stderr before other processing
        if (this.isRateLimitError(stderr) || this.isRateLimitError(stdout)) {
          const parsed = this.parseOutput(stdout);
          const cost = parsed.ok ? parsed.value.cost : 0;
          resolve(err(new SessionError('Rate limited by upstream provider', cost, true)));
          return;
        }

        if (timedOut) {
          const timedOutParsed = this.parseOutput(stdout);
          const timedOutCost = timedOutParsed.ok ? timedOutParsed.value.cost : 0;
          const timedOutOutput = timedOutParsed.ok ? timedOutParsed.value.output : stdout.trim();
          resolve(ok({
            output: timedOutOutput,
            structuredData: null,
            cost: timedOutCost,
            pitfallMarkers: this.extractPitfalls(timedOutOutput),
            exitStatus: 'timed-out' as ExitStatus,
            handoffNote: this.extractHandoff(timedOutOutput),
          }));
          return;
        }

        const parsed = this.parseOutput(stdout);
        if (!parsed.ok) {
          resolve(err(parsed.error));
          return;
        }

        const exitStatus: ExitStatus = code === 0 ? 'completed' : 'failed';

        resolve(ok({
          output: parsed.value.output,
          structuredData: parsed.value.structuredData,
          cost: parsed.value.cost,
          pitfallMarkers: this.extractPitfalls(parsed.value.output),
          exitStatus,
          handoffNote: this.extractHandoff(parsed.value.output),
        }));
      });

      proc.on('error', (e) => {
        clearTimeout(timer);
        if (hookPaths) this.cleanupHooks(hookPaths);
        const partialStdout = Buffer.concat(chunks).toString();
        const parsed = this.parseOutput(partialStdout);
        const cost = parsed.ok ? parsed.value.cost : 0;
        resolve(err(new SessionError(e.message, cost)));
      });
    });
  }

  /**
   * Extract a handoff note from session output delimited by [HANDOFF]...[/HANDOFF].
   * Returns undefined if absent or empty (spec: treat empty as absent).
   */
  extractHandoff(output: string): string | undefined {
    const match = output.match(/\[HANDOFF\]([\s\S]*?)\[\/HANDOFF\]/);
    const note = match?.[1]?.trim();
    return note || undefined;
  }

  /**
   * Detect rate limit signals in CLI output/stderr.
   * Matches common patterns: HTTP 429, "rate limit", "retry-after".
   */
  isRateLimitError(text: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    return (
      lower.includes('rate limit') ||
      lower.includes('rate_limit') ||
      lower.includes('429') ||
      lower.includes('too many requests') ||
      lower.includes('overloaded')
    );
  }

  private extractPitfalls(output: string): PitfallMarker[] {
    // Extract structured pitfall markers from session output
    // Format: <!-- PITFALL: {"artifactPatterns":["src/**"],"description":"..."} -->
    const markers: PitfallMarker[] = [];
    const regex = /<!-- PITFALL: ({.*?}) -->/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      try {
        const marker = JSON.parse(match[1] ?? '') as PitfallMarker;
        if (marker.artifactPatterns && marker.description) {
          markers.push(marker);
        }
      } catch {
        // skip malformed markers
      }
    }
    return markers;
  }
}
