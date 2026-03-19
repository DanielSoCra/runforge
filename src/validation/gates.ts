// src/validation/gates.ts
import { runCommand } from '../lib/process.js';
import type { GateResult, GateType, ReviewFinding } from '../types.js';

export interface Gate {
  type: GateType;
  execute(cwd: string): Promise<GateResult>;
}

export function createGate1(commands: string[]): Gate {
  return {
    type: 'deterministic',
    async execute(cwd: string): Promise<GateResult> {
      const findings: ReviewFinding[] = [];
      for (const cmd of commands) {
        const [bin, ...args] = cmd.split(' ');
        if (!bin) continue;
        const result = await runCommand(bin, args, { cwd, timeoutMs: 120_000 });
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
