import { describe, it, expect } from "vitest";
import { makeTempLedger } from "./helpers/temp-db.js";

describe("ReleaseLedger append-only + read-back", () => {
  it("reads a release id end to end in append order", async () => {
    const { writer, cleanup } = await makeTempLedger();
    const r = "release:acme/widgets:abc12345";
    await writer.append({ releaseId: r, deployment: "acme/widgets", event: "proposal", targetRevision: "abc12345", detail: { covered: 2 } });
    await writer.append({ releaseId: r, deployment: "acme/widgets", event: "decision", targetRevision: null, detail: { answer: "approve" } });
    await writer.append({ releaseId: r, deployment: "acme/widgets", event: "execution", targetRevision: "abc12345", detail: { outcome: "released" } });
    const rows = await writer.reader().eventsForRelease("acme/widgets", r);
    expect(rows.map((x) => x.event)).toEqual(["proposal", "decision", "execution"]);
    await cleanup();
  });
});
