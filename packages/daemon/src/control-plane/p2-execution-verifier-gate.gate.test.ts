// Guard shape under test: exported phases.ts helper gates an injected implement callback and returns proceeded/refused while raising escalation on governed verifier failure.
import { describe, expect, it, vi } from 'vitest';
import type { LaneEngineInputsResult } from './deployment-registry/types.js';
import type { ClassifierVerdict, LaneSet } from './lane-engine/types.js';
import type {
  VerifierDeclaration,
  VerifierGateResult,
  VerifierInvocationRef,
} from './lane-engine/verifier-gate/types.js';

type AssistReason = Extract<
  VerifierGateResult,
  { kind: 'assist-and-escalate' }
>['reason'];

type PreImplementVerifierGateDecision =
  | { kind: 'proceeded'; governed: boolean; laneName?: string }
  | { kind: 'refused'; governed: true; laneName: string; reason: AssistReason };

interface PreImplementVerifierGateEscalation {
  deploymentId: string;
  laneName: string;
  reason: AssistReason;
}

interface PreImplementVerifierGateRegistry {
  resolveLaneEngineInputs(deploymentId: string): LaneEngineInputsResult;
}

type CheckVerifierGateBeforeImplement = (args: {
  deploymentId?: string;
  registry?: PreImplementVerifierGateRegistry;
  classifierVerdict: ClassifierVerdict | null;
  probeOracle: (invoke: VerifierInvocationRef) => boolean;
  implement: () => Promise<unknown>;
  escalate: (event: PreImplementVerifierGateEscalation) => Promise<void>;
}) => Promise<PreImplementVerifierGateDecision>;

const verifier: VerifierDeclaration = {
  kind: 'test-suite',
  invoke: { ref: 'test' },
};

const matchingVerdict: ClassifierVerdict = {
  complexity: 'simple',
  changeKind: 'feature',
  scope: 'code',
};

function makeLaneSet(laneVerifier?: VerifierDeclaration): LaneSet {
  return {
    declaredPhases: ['velocity'],
    mostCautiousLane: 'p1',
    lanes: [
      {
        name: 'p1',
        qualify: { complexity: ['simple'] },
        allowedPaths: ['**/*'],
        roleRouting: { implementer: 'codex' },
        gateSet: 'standard',
        mergePolicy: 'review-then-auto',
        ...(laneVerifier !== undefined ? { verifier: laneVerifier } : {}),
      },
    ],
  };
}

function makeRegistry(laneSet: LaneSet): PreImplementVerifierGateRegistry {
  return {
    resolveLaneEngineInputs: () => ({
      kind: 'found',
      inputs: {
        laneSet,
        riskPathMap: [],
        defaultMinLevel: 'yellow',
        mode: 'velocity',
      },
    }),
  };
}

async function loadGuard(): Promise<CheckVerifierGateBeforeImplement> {
  const moduleRecord = (await import('./phases.js')) as Record<string, unknown>;
  const maybeGuard = moduleRecord.checkVerifierGateBeforeImplement as
    | CheckVerifierGateBeforeImplement
    | undefined;

  expect(
    maybeGuard,
    'G2 pre-implement verifier gate must be exported from phases.ts',
  ).toBeTypeOf('function');

  return maybeGuard!;
}

describe('G2 pre-implement verifier gate', () => {
  it('refuses governed implementation when the assigned lane declares no verifier', async () => {
    const checkVerifierGateBeforeImplement = await loadGuard();
    const implement = vi.fn(async () => 'implemented' as const);
    const escalate = vi.fn(async (_event: PreImplementVerifierGateEscalation) => undefined);

    const result = await checkVerifierGateBeforeImplement({
      deploymentId: 'runforge',
      registry: makeRegistry(makeLaneSet()),
      classifierVerdict: matchingVerdict,
      probeOracle: () => true,
      implement,
      escalate,
    });

    expect(result).toEqual({
      kind: 'refused',
      governed: true,
      laneName: 'p1',
      reason: 'no-verifier',
    });
    expect(implement).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: 'runforge',
        laneName: 'p1',
        reason: 'no-verifier',
      }),
    );
  });

  it('proceeds for governed implementation when the assigned lane has a runnable falsifying verifier', async () => {
    const checkVerifierGateBeforeImplement = await loadGuard();
    const implement = vi.fn(async () => 'implemented' as const);
    const escalate = vi.fn(async (_event: PreImplementVerifierGateEscalation) => undefined);
    const probeOracle = vi.fn((invoke: VerifierInvocationRef) => invoke.ref === 'test');

    const result = await checkVerifierGateBeforeImplement({
      deploymentId: 'runforge',
      registry: makeRegistry(makeLaneSet(verifier)),
      classifierVerdict: matchingVerdict,
      probeOracle,
      implement,
      escalate,
    });

    expect(result).toEqual({
      kind: 'proceeded',
      governed: true,
      laneName: 'p1',
    });
    expect(probeOracle).toHaveBeenCalledWith({ ref: 'test' });
    expect(implement).toHaveBeenCalledTimes(1);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('preserves legacy behavior for ungoverned runs regardless of verifier state', async () => {
    const checkVerifierGateBeforeImplement = await loadGuard();
    const implement = vi.fn(async () => 'implemented' as const);
    const escalate = vi.fn(async (_event: PreImplementVerifierGateEscalation) => undefined);
    const probeOracle = vi.fn((_invoke: VerifierInvocationRef) => false);

    const result = await checkVerifierGateBeforeImplement({
      classifierVerdict: matchingVerdict,
      probeOracle,
      implement,
      escalate,
    });

    expect(result).toEqual({ kind: 'proceeded', governed: false });
    expect(probeOracle).not.toHaveBeenCalled();
    expect(implement).toHaveBeenCalledTimes(1);
    expect(escalate).not.toHaveBeenCalled();
  });
});
