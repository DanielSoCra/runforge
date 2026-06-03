// src/session-runtime/adapters/cli.ts
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, mkdtempSync, unlinkSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ok, err, type Result } from '../../lib/result.js';
import type { AgentDefinition, SessionContext, SessionResult, ExitStatus, PitfallMarker, DirectoryScope, ProviderDefinition } from '../../types.js';
import type { ContainmentPolicy } from '../containment-hooks.js';
import type { ProviderAdapter } from './types.js';
import type { McpConfig } from '../plugin-injection.js';
import { generateContainmentScript } from '../generate-containment-script.js';
import { generateTimeoutHookScript } from '../timeout-hook-script.js';
import { SessionError } from '../session-error.js';
import { generateScopeHookScript, makeCliPermissionDenyEntries } from '../scope-enforcement.js';
import {
  registerManagedProcess,
  unregisterManagedProcess,
  killProcessGroup,
} from '../managed-processes.js';
import { seedClaudeProjectTrust } from '../claude-project-trust.js';

/**
 * The Claude CLI refuses --dangerously-skip-permissions under root/sudo. The
 * daemon image runs as root, so we must NOT pass that flag there (it's fatal) —
 * trust seeding clears the workspace gate instead. For non-root sandboxes the
 * flag remains the documented bypass and composes with the trust seed.
 */
function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

export class CliAdapter implements ProviderAdapter {
  buildArgs(
    def: AgentDefinition,
    prompt: string,
    jsonSchema?: string,
    provider?: ProviderDefinition,
    skipPermissions?: boolean,
  ): string[] {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--max-turns', String(def.maxTurns),
    ];
    const model = provider?.model ?? def.modelOverride;
    if (model) {
      args.push('--model', model);
    }
    if (def.allowedTools.length > 0) {
      args.push('--allowedTools', def.allowedTools.join(','));
    }
    if (jsonSchema) {
      args.push('--json-schema', jsonSchema);
    }
    // Permission bypass for autonomous, externally-sandboxed workers (the
    // container IS the sandbox). GATED: only when the caller turns the gate on —
    // interactive/native runs leave it off so the operator keeps the normal
    // permission prompts. It composes with the daemon's PreToolUse containment
    // hooks: Claude Code evaluates hooks (and deny rules) BEFORE the
    // permission-mode check, so a hook can still block a tool call (exit 2)
    // under bypass mode (see setupHooks() + generate-containment-script.ts).
    //
    // The CLI REFUSES this flag under root/sudo (fatal), and the daemon image
    // runs as root — so we suppress it there. Workspace trust is cleared the
    // root-safe way instead, by seeding the per-project trust entry before
    // spawn() (seedClaudeProjectTrust). Under a non-root sandbox the flag is
    // still the documented bypass.
    if (skipPermissions === true && !isRoot()) {
      args.push('--dangerously-skip-permissions');
    }
    return args;
  }

  buildEnv(extra?: Record<string, string>, provider?: ProviderDefinition): Record<string, string> {
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
    if (provider?.env) Object.assign(env, provider.env);
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
      const rawCost = typeof json['cost_usd'] === 'number'
        ? json['cost_usd']
        : typeof json['cost'] === 'number'
          ? json['cost']
          : 0;
      const cost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0;
      return ok({
        output,
        cost,
        structuredData: json,
      });
    } catch {
      // Non-JSON output means the CLI crashed, was killed, or produced unexpected output.
      // Returning ok() here would silently mask the failure and lose cost data.
      const truncated = stdout.length > 500 ? stdout.slice(0, 500) + '... [truncated]' : stdout;
      const rawPreview = truncated.trim() || '(empty output)';
      console.warn(`[cli-adapter] parseOutput: CLI produced non-JSON output: ${rawPreview}`);
      return err(new SessionError(
        `CLI produced non-JSON output (possible crash): ${rawPreview}`,
        0,
      ));
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
    mcpConfigs?: McpConfig[],
    directoryScope?: DirectoryScope,
  ): { scriptPaths: string[]; settingsPath: string; markerPath?: string } {
    const now = sessionStartTime ?? Date.now();
    const scriptPaths: string[] = [];
    const preToolUseHooks: { matcher: string; hooks: { type: string; command: string }[] }[] = [];

    // Containment hook — only when a policy is provided
    if (policy) {
      const containmentPath = join(tmpdir(), `containment-hook-${process.pid}-${now}.mjs`);
      // Bind absolute-path normalization to the worker's workspace, NOT the
      // daemon's process.cwd(). Critical under --dangerously-skip-permissions:
      // the PreToolUse hook is then the containment boundary, and without the
      // right project root, absolute paths normalize against the wrong base and
      // bypass blocked-pattern checks (SEC-2).
      writeFileSync(containmentPath, generateContainmentScript(policy, cwd), { mode: 0o755 });
      scriptPaths.push(containmentPath);
      preToolUseHooks.push({
        matcher: '',
        hooks: [{ type: 'command', command: `node "${containmentPath}"` }],
      });
    }

    if (directoryScope) {
      const scopePath = join(tmpdir(), `scope-hook-${process.pid}-${now}.mjs`);
      writeFileSync(
        scopePath,
        generateScopeHookScript(directoryScope, {
          sessionId: `cli-${now}`,
          agentType: 'cli',
          detectionLayer: 'pre-execution',
          workspacePath: cwd,
        }),
        { mode: 0o755 },
      );
      scriptPaths.push(scopePath);
      preToolUseHooks.push({
        matcher: '',
        hooks: [{ type: 'command', command: `node "${scopePath}"` }],
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

    if (directoryScope) {
      const existingPermissions = (settings.permissions ?? {}) as Record<string, unknown>;
      const existingDeny = Array.isArray(existingPermissions.deny)
        ? existingPermissions.deny.map(String)
        : [];
      const scopeDeny = makeCliPermissionDenyEntries(directoryScope);
      settings.permissions = {
        ...existingPermissions,
        deny: [...new Set([...existingDeny, ...scopeDeny])],
      };
      settings._scopeDenyEntries = scopeDeny;
    }

    // Inject plugin MCP server configs (ARCH-AC-PLUGINS Flow 4 step 3)
    // Merge with any pre-existing mcpServers — plugin configs take precedence on name collision
    if (mcpConfigs && mcpConfigs.length > 0) {
      const existing = (settings.mcpServers ?? {}) as Record<string, unknown>;
      const pluginServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
      for (const mcp of mcpConfigs) {
        const entry: { command: string; args: string[]; env?: Record<string, string> } = {
          command: mcp.command,
          args: mcp.args,
        };
        if (mcp.env && Object.keys(mcp.env).length > 0) {
          entry.env = mcp.env;
        }
        pluginServers[mcp.name] = entry;
      }
      settings.mcpServers = { ...existing, ...pluginServers };
      // Store injected names so cleanup only removes plugin-injected keys
      settings._pluginMcpNames = Object.keys(pluginServers);
    }

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
    // Remove only our hooks and plugin MCP configs from settings — restore previous state
    try {
      const content = readFileSync(paths.settingsPath, 'utf8');
      const settings = JSON.parse(content) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, unknown> | undefined;
      if (hooks) {
        delete hooks.PreToolUse;
        if (Object.keys(hooks).length === 0) delete settings.hooks;
      }
      // Remove only plugin-injected MCP servers, preserve pre-existing ones
      const injectedNames = settings._pluginMcpNames as string[] | undefined;
      if (injectedNames && settings.mcpServers) {
        const servers = settings.mcpServers as Record<string, unknown>;
        for (const name of injectedNames) {
          delete servers[name];
        }
        if (Object.keys(servers).length === 0) {
          delete settings.mcpServers;
        }
      }
      delete settings._pluginMcpNames;
      const scopeDenyEntries = settings._scopeDenyEntries as string[] | undefined;
      if (scopeDenyEntries && settings.permissions) {
        const permissions = settings.permissions as Record<string, unknown>;
        const deny = Array.isArray(permissions.deny) ? permissions.deny.map(String) : [];
        const scopeDenySet = new Set(scopeDenyEntries);
        const remaining = deny.filter(entry => !scopeDenySet.has(entry));
        if (remaining.length > 0) permissions.deny = remaining;
        else delete permissions.deny;
        if (Object.keys(permissions).length === 0) delete settings.permissions;
      }
      delete settings._scopeDenyEntries;
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
    options?: {
      cwd?: string;
      jsonSchema?: string;
      containmentPolicy?: ContainmentPolicy;
      mcpConfigs?: McpConfig[];
      directoryScope?: DirectoryScope;
      provider?: ProviderDefinition;
      skipPermissions?: boolean;
    },
  ): Promise<Result<SessionResult>> {
    const args = this.buildArgs(
      def,
      prompt,
      options?.jsonSchema,
      options?.provider,
      options?.skipPermissions,
    );
    const sessionStartTime = Date.now();
    const extraEnv: Record<string, string> = {
      SESSION_START_TIME: String(sessionStartTime),
      SESSION_TIMEOUT_MS: String(def.timeoutMs),
    };
    const env = this.buildEnv(extraEnv, options?.provider);

    // Set up hooks for EVERY session — timeout hooks are always needed,
    // containment hooks only when a policy is provided.
    // When cwd is not provided (e.g., codebase-reviewer), create a temp directory
    // so hooks can still be installed via .claude/settings.local.json.
    // SEC-34: Without this, sessions spawned without workspacePath run uncontained.
    let hookPaths: { scriptPaths: string[]; settingsPath: string; markerPath?: string } | undefined;
    let tempCwd: string | undefined;
    let effectiveCwd: string;
    if (options?.cwd) {
      effectiveCwd = options.cwd;
    } else {
      tempCwd = mkdtempSync(join(tmpdir(), 'session-cwd-'));
      effectiveCwd = tempCwd;
    }
    hookPaths = this.setupHooks(
      effectiveCwd,
      options?.containmentPolicy,
      def.timeoutMs,
      sessionStartTime,
      options?.mcpConfigs,
      options?.directoryScope,
    );

    // Autonomous/container gate: clear the CLI "Workspace not trusted" gate for
    // this worker's (dynamic) cwd the root-safe way. The daemon owns/created
    // effectiveCwd (a worktree or a daemon temp dir), and the PreToolUse hooks
    // installed just above remain the containment boundary. Best-effort: a seed
    // failure shouldn't crash the spawn — the CLI will surface the trust error
    // itself if the seed truly didn't take.
    if (options?.skipPermissions === true) {
      try {
        await seedClaudeProjectTrust(effectiveCwd);
      } catch (e) {
        console.warn(
          `[cli-adapter] workspace-trust seed failed for ${effectiveCwd}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const proc = spawn(
        options?.provider?.binaryPath ?? options?.provider?.cliTool ?? 'claude',
        args,
        {
        cwd: effectiveCwd,
        env,
        // detached: child leads its own process group so the timeout AND the
        // operator force-kill (SIGUSR2 → killAllManagedProcessGroups) can signal
        // the whole group (`kill -pid`), reaping the CLI's tool subprocesses too.
        detached: true,
        },
      );
      // Track in the shared registry so the operator force-kill path can reach
      // this child. Unregistered on close/error below.
      registerManagedProcess(proc);

      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const SIGTERM_GRACE_MS = 5_000;
      const timer = setTimeout(() => {
        timedOut = true;
        // Group-kill (negative pid) so tool subprocesses die with the CLI.
        killProcessGroup(proc, 'SIGTERM');
        killTimer = setTimeout(() => {
          killProcessGroup(proc, 'SIGKILL');
        }, SIGTERM_GRACE_MS);
      }, def.timeoutMs);

      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d));

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        unregisterManagedProcess(proc);
        if (hookPaths) this.cleanupHooks(hookPaths);
        if (tempCwd) { try { rmSync(tempCwd, { recursive: true, force: true }); } catch { /* best-effort */ } }
        const stdout = Buffer.concat(chunks).toString();
        const stderr = Buffer.concat(errChunks).toString();

        // Detect rate limit signals in stderr before other processing
        if (this.isRateLimitError(stderr) || this.isRateLimitError(stdout)) {
          const parsed = this.parseOutput(stdout);
          const cost = parsed.ok ? parsed.value.cost : 0;
          resolve(err(new SessionError('Rate limited by upstream provider', cost, true)));
          return;
        }

        if (stdout.includes('scope-violation') || stderr.includes('scope-violation')) {
          const parsed = this.parseOutput(stdout);
          const cost = parsed.ok ? parsed.value.cost : 0;
          const evidence = (stderr + '\n' + stdout).trim().slice(-1200);
          resolve(err(SessionError.scopeViolated(evidence || 'pre-execution hook blocked tool call', cost)));
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

        const reportedStatus = this.parseExitStatusFromOutput(parsed.value.output);
        // When the CLI exits non-zero but produced parseable output that the worker
        // marked as "completed", downgrade to 'completed-with-concerns' rather than
        // hard-failing the unit. The review gates still run; we don't loop at
        // implement burning budget on retries that won't improve. Other reported
        // statuses (failed/blocked/needs-context) are preserved as-is.
        const exitStatus: ExitStatus = code === 0
          ? reportedStatus
          : reportedStatus === 'completed'
            ? 'completed-with-concerns'
            : reportedStatus;

        if (code !== 0) {
          const stderrTail = stderr.trim().slice(-1200) || '(empty stderr)';
          const outputTail = parsed.value.output.trim().slice(-1200) || '(empty output)';
          console.warn(
            `[cli-adapter] claude exited ${code}; reported=${reportedStatus}; returning=${exitStatus}; stderr_tail=${JSON.stringify(stderrTail)}; output_tail=${JSON.stringify(outputTail)}`,
          );
        }

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
        if (killTimer) clearTimeout(killTimer);
        unregisterManagedProcess(proc);
        if (hookPaths) this.cleanupHooks(hookPaths);
        if (tempCwd) { try { rmSync(tempCwd, { recursive: true, force: true }); } catch { /* best-effort */ } }
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
   * Matches common patterns: HTTP 429, "rate limit", "too many requests", "overloaded_error".
   */
  isRateLimitError(text: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    return (
      lower.includes('rate limit') ||
      lower.includes('rate_limit') ||
      /\b429\b/.test(lower) ||
      lower.includes('too many requests') ||
      lower.includes('overloaded_error') ||
      lower.includes('api is overloaded')
    );
  }

  /**
   * Parse the agent's textual exit status from session output.
   * Agents report DONE_WITH_CONCERNS, BLOCKED, or NEEDS_CONTEXT per prompt templates.
   * Falls back to 'completed' if no status marker is found (agent said DONE or omitted status).
   */
  parseExitStatusFromOutput(output: string): ExitStatus {
    // Search from the end of output — status is reported at the end of the session.
    // Match the LAST occurrence of a status keyword to avoid false positives in earlier text.
    // DONE_WITH_CONCERNS and NEEDS_CONTEXT are compound tokens unlikely to appear in prose.
    // BLOCKED requires structured format (**BLOCKED**, - BLOCKED, or line-start BLOCKED)
    // to avoid false positives from narrative mentions like "the PR was BLOCKED by...".
    const reversed = output.split('\n').reverse();
    for (const line of reversed) {
      const upper = line.toUpperCase();
      if (upper.includes('DONE_WITH_CONCERNS')) return 'completed-with-concerns';
      if (upper.includes('NEEDS_CONTEXT')) return 'needs-context';
      // Require BLOCKED in structured position: bold (**BLOCKED**), list item (- BLOCKED),
      // or at line start (BLOCKED —). Prompt templates instruct "**BLOCKED**" format.
      if (/(?:^|\*\*|^-\s+)\s*BLOCKED\s*(?:\*\*|$|\s*—|\s*:)/.test(upper)) {
        return 'blocked';
      }
    }
    return 'completed';
  }

  private extractPitfalls(output: string): PitfallMarker[] {
    // Extract structured pitfall markers from session output
    // Format: <!-- PITFALL: {"artifactPatterns":["src/**"],"description":"..."} -->
    const markers: PitfallMarker[] = [];
    const regex = /<!-- PITFALL: ({.*?}) -->/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      try {
        const parsed = JSON.parse(match[1] ?? '') as Record<string, unknown>;
        if (Array.isArray(parsed.artifactPatterns) && typeof parsed.description === 'string') {
          markers.push({
            artifactPatterns: parsed.artifactPatterns.map(String),
            description: parsed.description,
          });
        }
      } catch {
        // skip malformed markers
      }
    }
    return markers;
  }
}
