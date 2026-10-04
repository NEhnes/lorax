import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const TMP_DB = path.join(os.tmpdir(), `lorax-phase6-${Date.now()}.db`);

process.env.LORAX_DB_PATH = TMP_DB;
process.env.TZ = "America/Detroit";

// The store opens the db lazily on first use, so point it at a temp file first.
const store = await import("../src/store");
const { canSendPrank, canReply, isStopRequest, isQuietHour, nextAllowedTime, validateOpenerText } =
  await import("../src/guardrails");

const FRIEND = "+15551234567";
const STRANGER = "+15559999999";

const ALLOWED_URL = "https://example.com/about";

/** Absolute timestamp at a given local wall-clock hour on a fixed day. */
function atLocalHour(hour: number, minute = 0) {
  // 2026-03-10 is a fixed local day; construct in local time via UTC offset math.
  const base = new Date(2026, 2, 10, hour, minute, 0, 0);
  return base.getTime();
}

beforeEach(() => {
  const fresh = `${TMP_DB}.${Math.random().toString(16).slice(2)}`;
  process.env.LORAX_DB_PATH = fresh;
  store.closeDb();
  store.getDb();
  for (const t of ["friends", "mutes", "users", "nudges", "send_log"]) {
    store.getDb().query(`DELETE FROM ${t}`).run();
  }
  store.addFriend(FRIEND, "Test Friend");
});

afterEach(() => {
  store.closeDb();
});

describe("allowlist", () => {
  test("blocks a prank to someone who is not on the allowlist", () => {
    const decision = canSendPrank(STRANGER, "prank_opener", atLocalHour(14));
    expect(decision.ok).toBe(false);
    expect((decision as { reason: string }).reason).toContain("allowlist");
  });

  test("allows an opener to an allowlisted friend during waking hours", () => {
    const decision = canSendPrank(FRIEND, "prank_opener", atLocalHour(14));
    expect(decision.ok).toBe(true);
  });

  test("a friend removed from the allowlist is blocked again", () => {
    expect(canSendPrank(FRIEND, "prank_opener", atLocalHour(14)).ok).toBe(true);
    store.removeFriend(FRIEND);
    expect(canSendPrank(FRIEND, "prank_opener", atLocalHour(14)).ok).toBe(false);
  });

  test("phone formatting does not bypass the allowlist", () => {
    const pretty = "+1 (555) 123-4567";
    expect(store.isFriend(pretty)).toBe(true);
    expect(canSendPrank(pretty, "prank_opener", atLocalHour(14)).ok).toBe(true);
  });
});

describe("quiet hours", () => {
  test("defers a send at 22:00 local with a retry time", () => {
    const at = atLocalHour(22);
    expect(isQuietHour(at)).toBe(true);
    const decision = canSendPrank(FRIEND, "prank_opener", at);
    expect(decision.ok).toBe(false);
    const retryAt = (decision as { retryAt?: number }).retryAt;
    expect(retryAt).toBeDefined();
    expect(retryAt!).toBeGreaterThan(at);
  });

  test("the retry time lands after 09:00 local", () => {
    const retryAt = nextAllowedTime(atLocalHour(23, 30));
    expect(isQuietHour(retryAt)).toBe(false);
    expect(new Date(retryAt).getHours()).toBeGreaterThanOrEqual(9);
  });

  test("does not defer during waking hours", () => {
    expect(isQuietHour(atLocalHour(10))).toBe(false);
    expect(isQuietHour(atLocalHour(20, 59))).toBe(false);
    expect(nextAllowedTime(atLocalHour(14))).toBe(atLocalHour(14));
  });

  test("blocks 02:00 local too", () => {
    const at = atLocalHour(2);
    expect(isQuietHour(at)).toBe(true);
    expect(canSendPrank(FRIEND, "prank_opener", at).ok).toBe(false);
  });
});

describe("follow-up cap", () => {
  function sendAt(at: number) {
    store.logSend({ phone: FRIEND, kind: "prank_followup", status: "sent", body: "hi", createdAt: at });
  }

  test("allows two follow-ups then blocks the third", () => {
    const base = atLocalHour(14);
    expect(canSendPrank(FRIEND, "prank_followup", base).ok).toBe(true);
    sendAt(base);

    expect(canSendPrank(FRIEND, "prank_followup", base + 2 * 60 * 60 * 1000).ok).toBe(true);
    sendAt(base + 2 * 60 * 60 * 1000);

    const third = canSendPrank(FRIEND, "prank_followup", base + 4 * 60 * 60 * 1000);
    expect(third.ok).toBe(false);
    expect((third as { reason: string }).reason).toContain("follow-up cap");
  });

  test("caps per friend, so one friend's usage does not block another's", () => {
    const other = "+15551110000";
    store.addFriend(other, "Other Friend");
    const base = atLocalHour(14);
    sendAt(base);
    sendAt(base + 2 * 60 * 60 * 1000);
    sendAt(base + 4 * 60 * 60 * 1000);
    expect(canSendPrank(FRIEND, "prank_followup", base + 6 * 60 * 60 * 1000).ok).toBe(false);
    expect(canSendPrank(other, "prank_followup", base + 6 * 60 * 60 * 1000).ok).toBe(true);
  });

  test("only one opener ever goes out per friend", () => {
    const base = atLocalHour(14);
    expect(canSendPrank(FRIEND, "prank_opener", base).ok).toBe(true);
    store.logSend({ phone: FRIEND, kind: "prank_opener", status: "sent", createdAt: base });
    const second = canSendPrank(FRIEND, "prank_opener", base + 3 * 60 * 60 * 1000);
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toContain("opener already sent");
  });

  test("follow-ups too close together are deferred, not blocked", () => {
    const base = atLocalHour(14);
    store.logSend({ phone: FRIEND, kind: "prank_opener", status: "sent", createdAt: base });
    const decision = canSendPrank(FRIEND, "prank_followup", base + 10 * 60 * 1000);
    expect(decision.ok).toBe(false);
    expect((decision as { retryAt?: number }).retryAt).toBe(base + 60 * 60 * 1000);
  });
});

describe("stop request", () => {
  test("recognizes stop phrasings", () => {
    for (const text of [
      "stop",
      "STOP",
      "please stop texting me",
      "leave me alone",
      "unfollow",
      "quit",
      "unsubscribe me",
      "do not contact me",
      "don't contact me",
    ]) {
      expect(isStopRequest(text)).toBe(true);
    }
  });

  test("does not fire on unrelated text", () => {
    for (const text of ["what is stopping deforestation?", "hi", "pester Acme"]) {
      expect(isStopRequest(text)).toBe(false);
    }
  });

  test("a stopped friend is blocked permanently, even while allowlisted", () => {
    const at = atLocalHour(14);
    expect(canSendPrank(FRIEND, "prank_opener", at).ok).toBe(true);
    store.mute(FRIEND, "asked to stop");

    const decision = canSendPrank(FRIEND, "prank_opener", at);
    expect(decision.ok).toBe(false);
    expect((decision as { reason: string }).reason).toContain("muted");
    expect(store.isMuted(FRIEND)).toBe(true);
    expect(store.isFriend(FRIEND)).toBe(true);
  });

  test("muted recipients get no replies either", () => {
    store.mute(FRIEND);
    expect(canReply(FRIEND, atLocalHour(14)).ok).toBe(false);
  });
});

describe("opener text rules", () => {
  test("accepts a plain question with no link", () => {
    expect(validateOpenerText("Did you water the ferns yet, or are you still busy pretending to be fine?").ok)
      .toBe(true);
  });

  test("rejects a message containing a link", () => {
    for (const text of [
      "Want the forest facts? https://example.com/report",
      "See www.example.com then tell me a story?",
      "Check forestdata.io for the truth, ok?",
    ]) {
      const decision = validateOpenerText(text);
      expect(decision.ok).toBe(false);
      expect((decision as { reason: string }).reason).toContain("link");
    }
  });

  test("rejects a message that does not end in a question", () => {
    const decision = validateOpenerText("I told the trees about you yesterday.");
    expect(decision.ok).toBe(false);
    expect((decision as { reason: string }).reason).toContain("question");
  });

  test("rejects empty and overlong text", () => {
    expect(validateOpenerText("   ").ok).toBe(false);
    expect(validateOpenerText(`${"a".repeat(300)}?`).ok).toBe(false);
  });
});

describe("claims without a source", () => {
  test("a claim sourced to a URL that search never returned is rejected", async () => {
    const { validateClaims } = await import("../src/tools");
    const searchResults = new Set([ALLOWED_URL]);
    const withSource = [
      { text: "One", source_url: ALLOWED_URL },
      { text: "Two", source_url: ALLOWED_URL },
      { text: "Three", source_url: ALLOWED_URL },
    ];
    expect(validateClaims(withSource, searchResults)).toBeNull();

    const unsourced = [...withSource.slice(0, 2), { text: "Three", source_url: "https://made.up/source" }];
    expect(validateClaims(unsourced, searchResults)).toContain("must match a URL returned by web_search");
  });
});

describe("database", () => {
  test("stores mutes, friends, and nudges on disk", () => {
    store.createNudge({ phone: FRIEND, kind: "opener", intent: "tease", sendAt: atLocalHour(14) });
    const nudge = store.dueNudges(Date.now());
    // sendAt is 14:00 local on 2026-03-10, which is in the past relative to now.
    expect(nudge.length).toBe(1);
    expect(nudge[0].phone).toBe(FRIEND);
  });

  test("rejects a malformed phone number", () => {
    expect(() => store.normalizePhone("not-a-phone")).toThrow();
  });
});

afterAll(() => {
  store.closeDb();
  for (const suffix of ["", ".0"]) {
    for (const ext of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(`${TMP_DB}${suffix}${ext}`);
      } catch {
        // best effort
      }
    }
  }
});
