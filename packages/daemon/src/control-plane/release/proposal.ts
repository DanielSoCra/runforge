import { DeclaredReleasePathSchema } from "../deployment-registry/schema.js";
import type { LandingTarget } from "../deployment-registry/types.js";
import type { AssembleArgs, PreviewResult, TrunkReader } from "./types.js";

export type { AssembleArgs, PreviewResult, TrunkReader };

function isLandingTarget(value: unknown): value is LandingTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "landsOn" in value &&
    typeof (value as Record<string, unknown>).landsOn === "string" &&
    (value as Record<string, unknown>).landsOn !== "" &&
    "productionReleasePath" in value
  );
}

export async function assembleReleaseProposal(
  args: AssembleArgs,
): Promise<PreviewResult> {
  const { deployment, registry, repositories, ledgerReader, trunkReader } = args;

  const declared = registry.readDeclaredData(deployment, "landing");
  if (declared.kind === "not-found") {
    return {
      kind: "unresolvable",
      deployment,
      reason: `landing target not declared for deployment "${deployment}"`,
    };
  }

  if (!isLandingTarget(declared.value)) {
    return {
      kind: "unresolvable",
      deployment,
      reason: `landing target for deployment "${deployment}" is missing or invalid`,
    };
  }

  const landing = declared.value;
  const pathParse = DeclaredReleasePathSchema.safeParse(landing.productionReleasePath);
  if (!pathParse.success) {
    return {
      kind: "unresolvable",
      deployment,
      reason: `productionReleasePath for deployment "${deployment}" is not one of the supported release shapes`,
    };
  }
  const declaredPath = pathParse.data;

  const repo = repositories[0];
  if (!repo) {
    return {
      kind: "unresolvable",
      deployment,
      reason: `deployment "${deployment}" has no configured repository`,
    };
  }

  const marker = await ledgerReader.lastReleasedMarker(deployment);
  const head = (await trunkReader.getTrunkHead(repo.owner, repo.name, landing.landsOn)).sha;

  if (marker === head) {
    return { kind: "nothing-to-release", deployment };
  }

  const commits =
    marker !== undefined && marker !== ''
      ? (await trunkReader.compareSince(repo.owner, repo.name, marker, head)).commits
      : (await trunkReader.listRecent(repo.owner, repo.name, head)).commits;

  const summary = `Release ${deployment}: ${commits.length} change(s) since ${marker ?? "first release"} → ${head.slice(0, 8)}`;

  return {
    kind: "proposal",
    proposal: {
      deployment,
      targetRevision: head,
      sinceRevision: marker,
      coveredWork: commits,
      declaredPath,
      summary,
    },
  };
}
