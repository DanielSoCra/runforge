import { describe, it, expect } from "vitest";
import { makeTempLedger } from "./helpers/temp-db.js";

describe("Last-Released Marker is DERIVED from the most recent released event", () => {
  it("advances on a released execution, not on triggered-awaiting", async () => {
    const { writer, cleanup } = await makeTempLedger();
    const d = "acme/widgets";
    await writer.append({ releaseId: "r1", deployment: d, event: "execution", targetRevision: "sha-A", detail: { outcome: "released" } });
    expect(await writer.reader().lastReleasedMarker(d)).toBe("sha-A");
    await writer.append({ releaseId: "r2", deployment: d, event: "execution", targetRevision: "sha-B", detail: { outcome: "triggered-awaiting" } });
    expect(await writer.reader().lastReleasedMarker(d)).toBe("sha-A"); // NOT advanced by a non-final outcome
    await writer.append({ releaseId: "r2", deployment: d, event: "completion", targetRevision: "sha-B", detail: { outcome: "released" } });
    expect(await writer.reader().lastReleasedMarker(d)).toBe("sha-B"); // completion(released) advances it
    await writer.append({ releaseId: "r3", deployment: d, event: "execution", targetRevision: "sha-C", detail: { outcome: "failed" } });
    expect(await writer.reader().lastReleasedMarker(d)).toBe("sha-B"); // failed never advances
    await cleanup();
  });
  it("returns undefined when the deployment has never released", async () => {
    const { writer, cleanup } = await makeTempLedger();
    expect(await writer.reader().lastReleasedMarker("never/released")).toBeUndefined();
    await cleanup();
  });
});
