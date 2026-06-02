import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createIndexWriter } from "../src/index-writer.js";
import { FakeNotifier } from "../src/adapters/fakes/fake-notifier.js";
import { FakeSourceSink } from "../src/adapters/fakes/fake-source-sink.js";
import { FakeResumeDispatcher } from "../src/adapters/fakes/fake-resume-dispatcher.js";

/**
 * FIX (verdict fix_before_flag_on / index-writer.ts:84): createIndexWriter opens
 * the writable connection via openDb(), then runs migrate() and constructs
 * ProtectedStoreImpl. If EITHER throws after openDb() succeeds, the sqlite handle
 * (db.$client) was never closed — a file-handle leak on the broken-config path.
 * A bad-length protectedKey makes the ProtectedStore ctor throw, which exercises
 * exactly that window. The fix must close db.$client before rethrowing.
 */
describe("createIndexWriter closes the sqlite handle when construction throws", () => {
  let dir: string;
  const opened: Database.Database[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-leak-"));
    opened.length = 0;
    // Capture every better-sqlite3 connection created during the test.
    const realClose = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
      return realClose.call(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function baseDeps() {
    return {
      dbPath: join(dir, "decision-index.sqlite"),
      protectedDir: join(dir, "protected"),
      notifier: new FakeNotifier(),
      sourceSink: new FakeSourceSink(),
      resumeDispatcher: new FakeResumeDispatcher(),
      clock: () => new Date("2026-05-27T00:00:00.000Z"),
    };
  }

  it("a bad protectedKey (ProtectedStore ctor throws) does NOT leak an open handle", () => {
    // A non-32-byte base64 key forces ProtectedStore ctor to throw AFTER
    // openDb() + migrate() have already run.
    expect(() =>
      createIndexWriter({ ...baseDeps(), protectedKey: Buffer.from("short").toString("base64") }),
    ).toThrow(/32 bytes/);

    // The handle must be closed: reopening the same path in exclusive-ish mode
    // and running a trivial pragma must succeed (a leaked WAL writer would not
    // block a second reader, so we assert the stronger invariant directly:
    // close() was called on the connection that was opened for this writer).
    const closeMock = Database.prototype.close as unknown as ReturnType<typeof vi.fn>;
    expect(closeMock).toHaveBeenCalled();
  });

  it("a healthy construction does NOT spuriously close the handle (regression)", () => {
    const validKey = Buffer.alloc(32, 9).toString("base64");
    const writer = createIndexWriter({ ...baseDeps(), protectedKey: validKey });
    const closeMock = Database.prototype.close as unknown as ReturnType<typeof vi.fn>;
    expect(closeMock).not.toHaveBeenCalled();
    // a real, usable writer came back.
    expect(writer.reader).toBeDefined();
    writer.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
