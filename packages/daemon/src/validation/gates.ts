// src/validation/gates.ts
import { runCommand } from '../lib/process.js';
import type { GateResult, GateType, ReviewFinding } from '../types.js';

export interface Gate {
  type: GateType;
  execute(cwd: string): Promise<GateResult>;
}

/**
 * Dangerous shell metacharacters that enable command injection when passed to sh -c.
 * Blocks: command chaining (;, &&, ||), subshells ($(), ``), redirects (>, <),
 * backgrounding (&), pipes (|), and escape sequences (\).
 */
const DANGEROUS_SHELL_PATTERN = /[;|&`$(){}><\n\\]/;

export function validateGate1Command(cmd: string): string | null {
  const matched = cmd.match(DANGEROUS_SHELL_PATTERN);
  if (matched) {
    return `Gate1 command contains disallowed shell character '${matched[0]}': ${cmd}`;
  }
  return null;
}

export interface Gate1Options {
  /**
   * When set, a command that fails post-change is re-run on this pristine base
   * checkout. If it ALSO fails there, the failure is pre-existing (not a
   * regression this run introduced) and does NOT block the gate — only NEW
   * failures block. Off (undefined) = strict: the first failure blocks, byte-
   * identical to the historical behavior. Used for self-targeted runs where the
   * repo's own suite may already be red (#3 / config.validation.baselinePreexistingFailures).
   */
  baselineCwd?: string;
}

export function createGate1(commands: string[], opts?: Gate1Options): Gate {
  return {
    type: 'deterministic',
    async execute(cwd: string): Promise<GateResult> {
      const findings: ReviewFinding[] = [];
      for (const cmd of commands) {
        if (!cmd.trim()) continue;
        const validationError = validateGate1Command(cmd);
        if (validationError) {
          findings.push({
            severity: 'critical',
            location: cmd,
            description: validationError,
          });
          return { gate: 'deterministic', passed: false, findings };
        }
        const result = await runCommand('/bin/sh', ['-c', cmd], { cwd, timeoutMs: 120_000 });
        if (result.ok) continue;

        // Command failed. In baseline mode, a command that also fails on the
        // pristine base is pre-existing — skip it so a flaky/red base test can't
        // stuck self-targeted runs. The base run reuses the same validated cmd.
        if (opts?.baselineCwd !== undefined) {
          const baseline = await runCommand('/bin/sh', ['-c', cmd], {
            cwd: opts.baselineCwd,
            timeoutMs: 120_000,
          });
          if (!baseline.ok) {
            console.log(
              `[gate1] '${cmd}' fails post-change AND on base — pre-existing, not blocking (${result.error.message.split('\n')[0]})`,
            );
            continue;
          }
          console.log(
            `[gate1] '${cmd}' passes on base but fails post-change — NEW failure, blocking`,
          );
        }
        findings.push({
          severity: 'critical',
          location: cmd,
          description: result.error.message,
        });
        return { gate: 'deterministic', passed: false, findings };
      }
      return { gate: 'deterministic', passed: true, findings };
    },
  };
}

export function selectGates(
  complexity: 'simple' | 'standard' | 'complex',
  riskSensitive: boolean,
  gate1: Gate,
  gate2?: Gate,
  gate3?: Gate,
  gate4?: Gate,
): Gate[] {
  const gates: Gate[] = [gate1];
  if (complexity === 'standard' || complexity === 'complex') {
    if (gate2) gates.push(gate2);
    if (gate3) gates.push(gate3);
  } else if (complexity === 'simple') {
    if (gate2) gates.push(gate2);
  }
  if (complexity === 'complex' || riskSensitive) {
    if (gate4 && !gates.includes(gate4)) gates.push(gate4);
  }
  return gates;
}
