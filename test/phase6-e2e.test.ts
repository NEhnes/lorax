/**
 * Proves the guardrails gate a real send, not just the decision function.
 * Stubs the model call and the transport; nothing is sent or billed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import os from "os";

process.env.LORAX_DB_PATH = path.join(os.tmpdir(), `lorax-e2e-${Date.now()}.db`);
process.env.TZ = "America/Detroit";

const store = await import("../src/store");
const { processNudge, drainDueNudges } = await import("../src/prank");

const FRIEND = "+15551234567";
const realFetch = globalThis.fetch;

/**
 * Fixed 14:00 local on a past day. Real "now" is 06:38 local, which is inside
 * quiet hours, so these tests pin their own clock to exercise the awake path.
 */
const AWAKE = new Date(2026, 2, 10, 14, 0, 0, 0).getTime();

function stubModel(text: string) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: text } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
}

const GOOD_OPENER = "Did you water the ferns yet, or are you still busy pretending to be fine?";

beforeEach(() => {
  store.closeDb();
  store.getDb();
  for (const t of ["friends", "mutes", "users", "nudges", "send_log"]) {
    store.getDb().query(`DELETE FROM ${t}`).run();
  }
  store.addFriend(FRIEND, "Test Friend");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  store.closeDb();
});

describe("prank delivery is guardrailed", () => {
  test("a stranger is blocked and the transport is never called", async () => {
    stubModel(GOOD_OPENER);
    const sent: string[] = [];
    const nudge = store.createNudge({
      phone: "+15559999999",
      kind: "opener",
      intent: "tease",
      sendAt: AWAKE,
    });

    const result = await processNudge(
      nudge,
      async (p) => {
        sent.push(p);
      },
      AWAKE,
      true,
    );
    expect(result.outcome).toContain("blocked");
    expect(sent).toHaveLength(0);
  });

  test("a muted friend is blocked and the transport is never called", async () => {
    stubModel(GOOD_OPENER);
    store.mute(FRIEND, "asked to stop");
    const sent: string[] = [];
    const nudge = store.createNudge({ phone: FRIEND, kind: "opener", intent: "tease", sendAt: AWAKE });

    const result = await processNudge(
      nudge,
      async (p) => {
        sent.push(p);
      },
      AWAKE,
      true,
    );
    expect(result.outcome).toContain("blocked");
    expect(sent).toHaveLength(0);
  });

  test("a model-generated opener containing a link is blocked before sending", async () => {
    stubModel("Read https://example.com/report and then admit you are lazy, ok?");
    const sent: string[] = [];
    const nudge = store.createNudge({ phone: FRIEND, kind: "opener", intent: "tease", sendAt: AWAKE });

    const result = await processNudge(
      nudge,
      async (p) => {
        sent.push(p);
      },
      AWAKE,
      true,
    );
    expect(result.outcome).toContain("link");
    expect(sent).toHaveLength(0);
  });

  test("a clean opener to an allowlisted friend is sent once", async () => {
    stubModel(GOOD_OPENER);
    const sent: string[] = [];
    const nudge = store.createNudge({ phone: FRIEND, kind: "opener", intent: "tease", sendAt: AWAKE });

    const result = await processNudge(
      nudge,
      async (p) => {
        sent.push(p);
      },
      AWAKE,
      false,
    );
    expect(result.outcome).toBe("sent");
    expect(sent).toEqual([FRIEND]);
    expect(result.body).toContain("fern");
  });

  test("dry run records the send without calling the transport", async () => {
    stubModel(GOOD_OPENER);
    const sent: string[] = [];
    const nudge = store.createNudge({ phone: FRIEND, kind: "opener", intent: "tease", sendAt: AWAKE });

    const result = await processNudge(
      nudge,
      async (p) => {
        sent.push(p);
      },
      AWAKE,
      true,
    );
    expect(result.outcome).toBe("dry-run");
    expect(sent).toHaveLength(0);
  });

  test("a second opener never reaches the transport", async () => {
    stubModel(GOOD_OPENER);
    const sent: string[] = [];
    const first = store.createNudge({ phone: FRIEND, kind: "opener", intent: "tease", sendAt: AWAKE });
    await processNudge(
      first,
      async (p) => {
        sent.push(p);
      },
      AWAKE,
      false,
    );

    const second = store.createNudge({ phone: FRIEND, kind: "opener", intent: "tease again", sendAt: AWAKE });
    const result = await processNudge(
      second,
      async (p) => {
        sent.push(p);
      },
      AWAKE,
      false,
    );
    expect(result.outcome).toContain("blocked");
    expect(sent).toHaveLength(1);
  });

  test("a send failure leaves the nudge pending so it is retried", async () => {
    stubModel(GOOD_OPENER);
    const nudge = store.createNudge({ phone: FRIEND, kind: "opener", intent: "tease", sendAt: AWAKE });
    const result = await processNudge(
      nudge,
      async () => {
        throw new Error("carrier rejected");
      },
      AWAKE,
      false,
    );
    expect(result.outcome).toContain("send failed");
    expect(store.dueNudges(AWAKE).map((n) => n.id)).toContain(nudge.id);
  });

  test("a nudge due during quiet hours is deferred, not dropped or sent", async () => {
    stubModel(GOOD_OPENER);
    const sent: string[] = [];
    const night = new Date(2026, 2, 10, 22, 30, 0, 0).getTime();
    const nudge = store.createNudge({ phone: FRIEND, kind: "opener", intent: "tease", sendAt: night });

    const result = await processNudge(
      nudge,
      async (p) => {
        sent.push(p);
      },
      night,
      false,
    );
    expect(result.outcome).toContain("deferred");
    expect(sent).toHaveLength(0);
    // Still pending, pushed to the first legal moment.
    expect(store.dueNudges(night)).toHaveLength(0);
    expect(store.dueNudges(night + 12 * 60 * 60 * 1000).map((n) => n.id)).toContain(nudge.id);
  });

  test("drainDueNudges processes only due nudges", async () => {
    stubModel(GOOD_OPENER);
    store.createNudge({ phone: FRIEND, kind: "opener", intent: "due", sendAt: AWAKE });
    store.createNudge({ phone: FRIEND, kind: "followup", intent: "later", sendAt: AWAKE + 3_600_000 });

    const results = await drainDueNudges(async () => {}, AWAKE, true);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("dry-run");
  });
});
