import { countSendsSince, countSendsTo, getDb, isFriend, isMuted, type SendKind } from "./store";

/** Quiet hours are 21:00-09:00 local. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 9;

/** One opener plus two follow-ups per friend, and at least this long between them. */
export const MAX_FOLLOWUPS = 2;
export const MIN_GAP_MINUTES = 60;

/** Photon's documented iMessage caps. We stay far below both. */
export const DAILY_MESSAGE_CAP = 5000;
export const DAILY_NEW_CONVERSATION_CAP = 50;

export type Decision =
  | { ok: true }
  | { ok: false; reason: string; retryAt?: number };

const ok: Decision = { ok: true };

function blocked(reason: string): Decision {
  return { ok: false, reason };
}

/** Hour-of-day in the configured local timezone, derived from an absolute timestamp. */
export function localHour(at: number, timeZone = process.env.TZ) {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone,
    }).format(new Date(at)),
  );
}

export function isQuietHour(at: number, timeZone = process.env.TZ) {
  const hour = localHour(at, timeZone);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** First moment at or after `at` that is outside quiet hours. */
export function nextAllowedTime(at: number, timeZone = process.env.TZ) {
  if (!isQuietHour(at, timeZone)) return at;
  const hour = localHour(at, timeZone);
  // Hours from now until QUIET_END_HOUR, wrapping past midnight when needed.
  const hours = (24 - hour + QUIET_END_HOUR) % 24;
  // Land a few minutes past the top of the hour rather than exactly on it.
  return at + hours * 60 * 60 * 1000 + 5 * 60 * 1000;
}

/**
 * Reply to someone who texted us. Inbound-first, so only the recipient's
 * mute state and the platform ceiling apply here.
 */
export function canReply(phone: string | null | undefined, at: number = Date.now()): Decision {
  if (!phone) return blocked("no sender id");
  if (isMuted(phone)) return blocked("recipient is muted");
  if (countSendsSince(startOfDay(at)) >= DAILY_MESSAGE_CAP) {
    return blocked("daily message cap reached");
  }
  return ok;
}

/**
 * Outbound to a friend. Every hard constraint applies: allowlist, mute,
 * quiet hours, follow-up cap, spacing, and the platform ceiling.
 */
export function canSendPrank(
  phone: string,
  kind: SendKind,
  at: number = Date.now(),
  timeZone = process.env.TZ,
): Decision {
  if (!isFriend(phone)) return blocked("not on the friends allowlist");
  if (isMuted(phone)) return blocked("recipient is muted");

  if (countSendsSince(startOfDay(at)) >= DAILY_MESSAGE_CAP) {
    return blocked("daily message cap reached");
  }
  if (countSendsTo(phone, kind, startOfDay(at)) >= DAILY_NEW_CONVERSATION_CAP) {
    return blocked("daily new-conversation cap reached");
  }

  if (isQuietHour(at, timeZone)) {
    const retryAt = nextAllowedTime(at, timeZone);
    return { ok: false, reason: "quiet hours 21:00-09:00 local", retryAt };
  }

  if (kind === "prank_followup") {
    const priorFollowups = countSendsTo(phone, "prank_followup", 0);
    if (priorFollowups >= MAX_FOLLOWUPS) {
      return blocked(`follow-up cap reached (${MAX_FOLLOWUPS} per friend)`);
    }
    const last = lastSendTo(phone, at);
    if (last !== null && at - last < MIN_GAP_MINUTES * 60 * 1000) {
      return {
        ok: false,
        reason: `follow-ups must be spaced ${MIN_GAP_MINUTES}+ minutes apart`,
        retryAt: last + MIN_GAP_MINUTES * 60 * 1000,
      };
    }
  }

  if (kind === "prank_opener" && countSendsTo(phone, "prank_opener", 0) >= 1) {
    return blocked("opener already sent to this friend");
  }

  return ok;
}

function lastSendTo(phone: string, before: number): number | null {
  const row = getDb()
    .query(
      "SELECT MAX(created_at) AS last FROM send_log WHERE phone = ? AND status = 'sent' AND created_at < ?",
    )
    .get(phone, before) as { last: number | null } | null;
  return row?.last ?? null;
}

function startOfDay(at: number) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|co|me)\b)/i;

/**
 * Prank openers are text-only, carry no links, and end with a question so the
 * friend can answer. Enforced on generated copy before it is allowed to send.
 */
export function validateOpenerText(text: string): Decision {
  const body = text.trim();
  if (!body) return blocked("opener text is empty");
  if (LINK_RE.test(body)) return blocked("opener must not contain a link");
  if (body.length > 300) return blocked("opener must fit one iMessage (300 chars)");
  if (!/[?]\s*$/.test(body)) return blocked("opener must end with a question");
  return ok;
}

/** A STOP (or equivalent) anywhere in the inbound text mutes permanently. */
export function isStopRequest(text: string) {
  return /\b(stop|leave me alone|unfollow|unsubscribe|quit|do not contact me|don'?t contact me)\b/i.test(
    text.trim(),
  );
}
