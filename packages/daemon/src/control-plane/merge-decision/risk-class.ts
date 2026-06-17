// packages/daemon/src/control-plane/merge-decision/risk-class.ts
//
// Maps a lane-engine RiskLevel (green..red) onto the decision-escalation
// risk_class (P0..P3) the ledger persists. The two vocabularies are distinct
// on purpose; this is the only place the translation lives. STUB — Kimi fills
// the body. Mapping the tests assert: red→P0, orange→P1, yellow→P2, green→P3.

import type { RiskLevel } from '../lane-engine/types.js';

export function toDecisionRiskClass(level: RiskLevel): 'P0' | 'P1' | 'P2' | 'P3' {
  switch (level) {
    case 'red':
      return 'P0';
    case 'orange':
      return 'P1';
    case 'yellow':
      return 'P2';
    case 'green':
      return 'P3';
    default: {
      const _exhaustive: never = level;
      throw new Error(`unknown RiskLevel: ${_exhaustive}`);
    }
  }
}
