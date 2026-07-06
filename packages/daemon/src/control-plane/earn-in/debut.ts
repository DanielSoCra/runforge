// packages/daemon/src/control-plane/earn-in/debut.ts
// Debut derivation: the first-ever widening to a widened state is the debut.

import type { WideningRecord } from '../deployment-registry/types.js';

/**
 * True iff the deployment has NEVER before widened to a widened state. Any prior
 * widening (operator-grant or earn-in-policy) means the crossing was witnessed.
 */
export function isDebut(history: WideningRecord[]): boolean {
  return !history.some((r) => r.next === 'widened');
}
