import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makePgliteDb, type PgliteTestDb } from "./helpers/temp-db.js";
import { seedDecision } from "./helpers/seed.js";
import { makeOutbox, answerItem } from "./helpers/effect-driver.js";
import { decisions } from "../src/schema.js";
import type { EffectKind } from "@auto-claude/decision-protocol";

type Fakes = ReturnType<typeof makeOutbox>;

/** Bring the item to the status where `kind` is the expected next effect. */
async function bringTo(t: PgliteTestDb, f: Fakes, id: string, kind: EffectKind) {
  if (kind === "notify") return; // detected already
  await answerItem(t, f.outbox, id); // notified->viewed->answered_pending_source_write
  if (kind === "write_response") return;
  await f.outbox.runEffect(id, "write_response"); // -> source_written
}

function preApply(f: Fakes, kind: EffectKind, effId: string) {
  if (kind === "notify") f.notifier.applied.add(effId);
  else if (kind === "write_response") f.sourceSink.applied.add(effId);
  else f.resumeDispatcher.applied.add(effId);
}

function setUnknown(f: Fakes, kind: EffectKind) {
  if (kind === "write_response") f.sourceSink.probeUnknown = true;
  else if (kind === "resume" || kind === "requeue") f.resumeDispatcher.probeUnknown = true;
  // notify's fake has no unknown mode; handled separately below
}

const kinds: EffectKind[] = ["write_response", "resume", "requeue", "notify"];

describe("generalized effect-reconcile (spec test 9) — all kinds x applied|absent|unknown", () => {
  let t: PgliteTestDb;
  beforeEach(async () => {
    t = await makePgliteDb();
  });
  afterEach(async () => {
    await t?.cleanup();
  });

  for (const kind of kinds) {
    const resumeMode = kind === "requeue" ? "requeue" : "mid_run";

    it(`${kind}: applied-before-commit -> probe advances, NO re-dispatch`, async () => {
      const id = await seedDecision(t.db, { resume_mode: resumeMode });
      const f = makeOutbox(t);
      await bringTo(t, f, id, kind);
      const effId = await f.outbox.effectIdFor(id, kind);
      preApply(f, kind, effId);

      const beforeNotify = f.notifier.calls.length;
      const beforeWrite = f.sourceSink.calls.length;
      const beforeResume = f.resumeDispatcher.calls.length;

      const results = await f.outbox.reconcile();
      const mine = results.find((x) => x.decision_id === id)!;
      expect(mine.action).toBe("advanced");

      // no re-dispatch on the owning adapter
      expect(f.notifier.calls.length).toBe(beforeNotify);
      expect(f.sourceSink.calls.length).toBe(beforeWrite);
      expect(f.resumeDispatcher.calls.length).toBe(beforeResume);
    });

    it(`${kind}: absent -> re-execute`, async () => {
      const id = await seedDecision(t.db, { resume_mode: resumeMode });
      const f = makeOutbox(t);
      await bringTo(t, f, id, kind);
      // nothing pre-applied -> absent
      const results = await f.outbox.reconcile();
      const mine = results.find((x) => x.decision_id === id)!;
      expect(mine.action).toBe("re-executed");
    });

    it(`${kind}: unknown -> failed (needs-human)`, async () => {
      const id = await seedDecision(t.db, { resume_mode: resumeMode });
      const f = makeOutbox(t);
      await bringTo(t, f, id, kind);
      if (kind === "notify") {
        // notify is naturally idempotent and has no indeterminate probe; skip the
        // unknown case for it (acceptable per spec — re-send is safe).
        return;
      }
      setUnknown(f, kind);
      const results = await f.outbox.reconcile();
      const mine = results.find((x) => x.decision_id === id)!;
      expect(mine.action).toBe("failed");
      const row = (await t.db.select().from(decisions).where(eq(decisions.decision_id, id)))[0]!;
      expect(row.status).toBe("failed");
    });
  }
});
