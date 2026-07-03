import type { ReleaseLane } from "./executor.js";
import type { ReleaseLedgerReader } from "@auto-claude/release-ledger";

export interface ResolveAnsweredReleasesDeps {
  lane: Pick<ReleaseLane, "resolveRelease">;
  reader: Pick<ReleaseLedgerReader, "openReleases">;
}

export async function resolveAnsweredReleases(
  deps: ResolveAnsweredReleasesDeps,
): Promise<void> {
  const open = await deps.reader.openReleases();
  for (const { deployment, releaseId } of open) {
    try {
      await deps.lane.resolveRelease(deployment, releaseId);
    } catch (e) {
      // A per-release failure must not prevent the sweep from continuing.
      // The lane is responsible for marking the deployment degraded.
      console.error(
        `[release-consumer] resolveRelease failed for ${deployment}:${releaseId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
