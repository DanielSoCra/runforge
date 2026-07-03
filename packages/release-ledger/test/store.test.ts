import { describe, it, expect } from "vitest";
import { makeTempLedger } from "./helpers/temp-db.js";

describe("ReleaseLedger store contracts", () => {
  it("appendProposalIfAbsent is idempotent", async () => {
    const { writer, cleanup } = await makeTempLedger();
    const r = "release:acme/widgets:idemp0001";
    const first = await writer.appendProposalIfAbsent({
      releaseId: r,
      deployment: "acme/widgets",
      event: "proposal",
      targetRevision: "idemp0001",
      detail: { n: 1 },
    });
    const second = await writer.appendProposalIfAbsent({
      releaseId: r,
      deployment: "acme/widgets",
      event: "proposal",
      targetRevision: "idemp0001",
      detail: { n: 2 },
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const rows = await writer.reader().eventsForRelease("acme/widgets", r);
    expect(rows.filter((x) => x.event === "proposal")).toHaveLength(1);
    await cleanup();
  });

  it("openReleases includes proposals, stays open after decision, drops after resolved", async () => {
    const { writer, cleanup } = await makeTempLedger();
    const r = "release:acme/widgets:open0001";
    await writer.appendProposalIfAbsent({
      releaseId: r,
      deployment: "acme/widgets",
      event: "proposal",
      targetRevision: "open0001",
      detail: { issueNumber: 7 },
    });
    let open = await writer.reader().openReleases();
    expect(open.map((o) => o.releaseId)).toContain(r);
    expect(open.find((o) => o.releaseId === r)?.detail).toEqual(
      expect.objectContaining({ issueNumber: 7 }),
    );

    await writer.append({
      releaseId: r,
      deployment: "acme/widgets",
      event: "decision",
      targetRevision: null,
      detail: { answer: "approve" },
    });
    open = await writer.reader().openReleases();
    expect(open.map((o) => o.releaseId)).toContain(r);

    await writer.append({
      releaseId: r,
      deployment: "acme/widgets",
      event: "resolved",
      targetRevision: null,
      detail: { answer: "approve" },
    });
    open = await writer.reader().openReleases();
    expect(open.map((o) => o.releaseId)).not.toContain(r);

    await cleanup();
  });

  it("concurrent appendProposalIfAbsent appends exactly one proposal", async () => {
    const { writer, cleanup } = await makeTempLedger();
    const r = "release:acme/widgets:conc0001";
    const e = {
      releaseId: r,
      deployment: "acme/widgets",
      event: "proposal" as const,
      targetRevision: "conc0001",
      detail: { n: 1 },
    };
    const results = await Promise.all([
      writer.appendProposalIfAbsent(e),
      writer.appendProposalIfAbsent({ ...e, detail: { n: 2 } }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await writer.reader().eventsForRelease("acme/widgets", r);
    expect(rows.filter((x) => x.event === "proposal")).toHaveLength(1);
    await cleanup();
  });

  it("appendAttemptIfAbsent is an idempotent single-attempt claim", async () => {
    const { writer, cleanup } = await makeTempLedger();
    const r = "release:acme/widgets:attidem1";
    const e = {
      releaseId: r,
      deployment: "acme/widgets",
      event: "attempt" as const,
      targetRevision: "attidem1",
      detail: { shape: "platform-performs" },
    };
    const first = await writer.appendAttemptIfAbsent!(e);
    const second = await writer.appendAttemptIfAbsent!({ ...e, detail: { shape: "trigger-automated" } });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const rows = await writer.reader().eventsForRelease("acme/widgets", r);
    expect(rows.filter((x) => x.event === "attempt")).toHaveLength(1);
    await cleanup();
  });

  it("concurrent appendAttemptIfAbsent claims exactly one attempt (partial unique index rejects the second)", async () => {
    const { writer, cleanup } = await makeTempLedger();
    const r = "release:acme/widgets:attconc1";
    const e = {
      releaseId: r,
      deployment: "acme/widgets",
      event: "attempt" as const,
      targetRevision: "attconc1",
      detail: { shape: "platform-performs" },
    };
    const results = await Promise.all([
      writer.appendAttemptIfAbsent!(e),
      writer.appendAttemptIfAbsent!({ ...e, detail: { shape: "trigger-automated" } }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one claim won
    const rows = await writer.reader().eventsForRelease("acme/widgets", r);
    expect(rows.filter((x) => x.event === "attempt")).toHaveLength(1);
    await cleanup();
  });
});
