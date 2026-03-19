// src/session-runtime/adapters/cli.ts
import { spawn } from 'child_process';
import { ok, err, type Result } from '../../lib/result.js';
import type { AgentDefinition, SessionContext, SessionResult, ExitStatus, PitfallMarker } from '../../types.js';
import type { ProviderAdapter } from './types.js';

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

  async spawn(
    def: AgentDefinition,
    prompt: string,
    options?: { cwd?: string; jsonSchema?: string },
  ): Promise<Result<SessionResult>> {
    const args = this.buildArgs(def, prompt, options?.jsonSchema);
    const env = this.buildEnv();

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
        const stdout = Buffer.concat(chunks).toString();

        if (timedOut) {
          resolve(ok({
            output: stdout.trim(),
            structuredData: null,
            cost: 0,
            pitfallMarkers: [],
            exitStatus: 'timed-out' as ExitStatus,
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
        }));
      });

      proc.on('error', (e) => {
        clearTimeout(timer);
        resolve(err(e));
      });
    });
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
