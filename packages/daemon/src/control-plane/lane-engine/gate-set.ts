// packages/daemon/src/control-plane/lane-engine/gate-set.ts
//
// Lane-specific gate-set VERDICT (XCUT P2#1) — the pure core. STUB only: the
// acceptance contract (gate-set.test.ts) is immovable; the body is filled by the
// external implementer (Kimi). No I/O, no Date.now(), no mutation of inputs.
//
// Contract (the implementer must satisfy it verbatim):
//   gateSetVerdict(required, passedGates) === true
//     IFF every key in `required` is present in `passedGates`.
//   - empty `required` ⇒ true (a set that demands nothing is satisfied).
//   - extra keys in `passedGates` beyond `required` are IGNORED.
//   - a single required key absent from `passedGates` ⇒ false (fail-closed).
// Total function: defined for every input, never throws, reads nothing external.
//
// FUNC-AC-MERGE-DECISION ("execute the gate set") / ARCH-AC-LANE-ENGINE
// ("the Validation Service executes the lane's selected gate set; verdicts return
// to the merge decision"). This wires the OBSERVED verdict backward into the
// merge decision; it does NOT run gates (that is the DEFERRED Plan-2 follow-up).

/**
 * True iff every gate key in `required` is present in `passedGates`.
 *
 * @param required    the gate keys a gate-set definition demands (closed set).
 * @param passedGates the gate keys that RAN and PASSED this run (observed).
 *                    Accepts a Set or an array; an array is membership-tested.
 */
export function gateSetVerdict(
  required: readonly string[],
  passedGates: ReadonlySet<string> | readonly string[],
): boolean {
  const present =
    passedGates instanceof Set
      ? passedGates
      : new Set<string>(passedGates);
  return required.every((key) => present.has(key));
}
