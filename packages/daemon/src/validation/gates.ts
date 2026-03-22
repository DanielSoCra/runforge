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

export function createGate1(commands: string[]): Gate {
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
        const result = await runCommand('sh', ['-c', cmd], { cwd, timeoutMs: 120_000 });
        if (!result.ok) {
          findings.push({
            severity: 'critical',
            location: cmd,
            description: result.error.message,
          });
          return { gate: 'deterministic', passed: false, findings };
        }
      }
      return { gate: 'deterministic', passed: true, findings: [] };
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
