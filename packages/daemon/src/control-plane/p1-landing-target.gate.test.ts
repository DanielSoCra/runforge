// G1 gate: the integrate lane resolves its merge trunk from the deployment's
// landing.landsOn for a governed deployment, FAILS CLOSED (escalate, no merge)
// when landing is not-found for a configured deployment, and falls back to the
// legacy config.branches.staging only for an ungoverned (no-deployment) run.
// Tests a `resolveLandingTarget` seam via runtime lookup so the file typechecks
// at RED without a static import of the not-yet-existing module.
import { describe, expect, it, vi } from 'vitest';

const LANDING_MODULE_PATH = './landing-target.js';

type DeclaredDataResult =
  | { kind: 'found'; value: unknown }
  | { kind: 'not-found' };

interface LandingRegistry {
  ownsRepo: (owner: string, repo: string) => boolean;
  readDeclaredData: (deploymentId: string, key: 'landing') => DeclaredDataResult;
}

interface ResolveLandingArgs {
  registry: LandingRegistry | undefined;
  deploymentId: string | undefined;
  fallbackStaging: string;
}

type LandingResolution =
  | { kind: 'governed'; landsOn: string }
  | { kind: 'ungoverned'; landsOn: string }
  | { kind: 'escalate'; reason: string };

type ResolveLandingTarget = (args: ResolveLandingArgs) => LandingResolution;

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadResolveLandingTarget(): Promise<ResolveLandingTarget> {
  let mod: Record<string, unknown> = {};
  try {
    mod = (await import(LANDING_MODULE_PATH)) as unknown as Record<string, unknown>;
  } catch (error: unknown) {
    mod = { __loadError: error };
  }
  const fn = mod.resolveLandingTarget as ResolveLandingTarget | undefined;
  expect(
    fn,
    `resolveLandingTarget must be exported from ${LANDING_MODULE_PATH}; load error: ${formatUnknownError(mod.__loadError)}`,
  ).toBeTypeOf('function');
  return fn!;
}

function makeRegistry(landing: DeclaredDataResult): LandingRegistry {
  return {
    ownsRepo: vi.fn(() => true),
    readDeclaredData: vi.fn((_id: string, _key: 'landing') => landing),
  };
}

describe('G1 resolveLandingTarget', () => {
  it('uses landing.landsOn for a governed deployment', async () => {
    const resolve = await loadResolveLandingTarget();
    const registry = makeRegistry({
      kind: 'found',
      value: { landsOn: 'main', productionReleasePath: 'release-sh' },
    });

    const result = resolve({ registry, deploymentId: 'auto-claude', fallbackStaging: 'staging' });

    expect(result).toEqual({ kind: 'governed', landsOn: 'main' });
  });

  it('FAILS CLOSED (escalate, no merge target) when landing is not-found for a configured deployment', async () => {
    const resolve = await loadResolveLandingTarget();
    const registry = makeRegistry({ kind: 'not-found' });

    const result = resolve({ registry, deploymentId: 'auto-claude', fallbackStaging: 'staging' });

    expect(result.kind).toBe('escalate');
    if (result.kind === 'escalate') {
      expect(result.reason).toMatch(/landing/i);
    }
    // Must NOT silently fall back to the legacy staging branch for a governed deployment.
    expect(result).not.toMatchObject({ kind: 'ungoverned' });
    expect(result).not.toMatchObject({ landsOn: 'staging' });
  });

  it('falls back to config.branches.staging only for an ungoverned (no-deployment) run', async () => {
    const resolve = await loadResolveLandingTarget();

    const result = resolve({
      registry: undefined,
      deploymentId: undefined,
      fallbackStaging: 'staging',
    });

    expect(result).toEqual({ kind: 'ungoverned', landsOn: 'staging' });
  });
});
