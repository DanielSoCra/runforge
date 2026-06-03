/**
 * Sensitivity classes and the fail-closed classification gate.
 *
 * Ordering: public < internal < phi < secret
 *   public | internal -> all sinks
 *   phi    | secret    -> protected store only (never any SQLite table, audit, or notification)
 */
import { SENSITIVITY_FIELD_PATHS } from "./field-paths.js";

export const SENSITIVITY_CLASSES = ["public", "internal", "phi", "secret"] as const;
export type SensitivityClass = (typeof SENSITIVITY_CLASSES)[number];

const RANK: Record<SensitivityClass, number> = {
  public: 0,
  internal: 1,
  phi: 2,
  secret: 3,
};

export function sensitivityRank(c: SensitivityClass): number {
  return RANK[c];
}

export type Sink = "all" | "protected";

/** Which sinks a value of the given class may flow to. */
export function allowedSinks(c: SensitivityClass): Sink[] {
  switch (c) {
    case "public":
    case "internal":
      return ["all"];
    case "phi":
    case "secret":
      return ["protected"];
  }
}

/** True if the class must be redacted into the protected store before any SQLite write. */
export function isProtected(c: SensitivityClass): boolean {
  return c === "phi" || c === "secret";
}

export class IncompleteClassificationError extends Error {
  readonly missingPaths: string[];
  constructor(missingPaths: string[]) {
    super(
      `DecisionRequest field_sensitivity is incomplete; missing classification for: ${missingPaths.join(
        ", ",
      )}`,
    );
    this.name = "IncompleteClassificationError";
    this.missingPaths = missingPaths;
  }
}

interface HasFieldSensitivity {
  field_sensitivity: Record<string, SensitivityClass>;
}

/**
 * Fail-closed gate (§5.1). Every canonical content path — including nested ones
 * like `options[].label` — must have an explicit class. A partial/missing map
 * throws IncompleteClassificationError{missingPaths}; the item is then NOT admitted.
 */
export function assertFullyClassified(request: HasFieldSensitivity): void {
  const map = request.field_sensitivity ?? {};
  const missingPaths = SENSITIVITY_FIELD_PATHS.filter(
    (p) => !Object.prototype.hasOwnProperty.call(map, p) || map[p] === undefined,
  );
  if (missingPaths.length > 0) {
    throw new IncompleteClassificationError(missingPaths);
  }
}
