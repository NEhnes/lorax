import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";

export type SendKind = "reply" | "prank_opener" | "prank_followup";
export type NudgeKind = "opener" | "followup";
export type NudgeStatus = "pending" | "sent" | "deferred" | "blocked" | "skipped";
export type SendStatus = "sent" | "blocked" | "deferred" | "dry_run";

export type Nudge = {
  id: number;
  phone: string;
  kind: NudgeKind;
  intent: string;
  send_at: number;
  status: NudgeStatus;
  created_at: number;
  sent_at: number | null;
};

let db: Database | null = null;

export function dbPath() {
  return process.env.LORAX_DB_PATH || path.resolve(process.cwd(), "data", "lorax.db");
}

export function getDb() {
  if (db) return db;
  const filename = dbPath();
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  db = new Database(filename, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS friends (
      phone     TEXT PRIMARY KEY,
      name      TEXT,
      added_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mutes (
      phone      TEXT PRIMARY KEY,
      reason     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      phone     TEXT PRIMARY KEY,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nudges (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      intent     TEXT NOT NULL,
      send_at    INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      sent_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS nudges_due ON nudges (status, send_at);
    CREATE TABLE IF NOT EXISTS send_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      status     TEXT NOT NULL,
      detail     TEXT,
      body       TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS send_log_phone ON send_log (phone, created_at);
  `);
  return db;
}

export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}

/** Strip formatting so +1 (555) 123-4567 and +15551234567 are the same friend. */
export function normalizePhone(phone: string) {
  const trimmed = String(phone ?? "").trim();
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (!/^\+?\d{5,}$/.test(digits)) throw new Error(`not a valid phone number: ${phone}`);
  return digits.startsWith("+") ? digits : `+${digits}`;
}

export function addFriend(phone: string, name?: string) {
  const p = normalizePhone(phone);
  getDb()
    .query("INSERT OR REPLACE INTO friends (phone, name, added_at) VALUES (?, ?, ?)")
    .run(p, name ?? null, Date.now());
  return p;
}

export function removeFriend(phone: string) {
  return getDb().query("DELETE FROM friends WHERE phone = ?").run(normalizePhone(phone)).changes;
}

export function listFriends() {
  return getDb().query("SELECT phone, name, added_at FROM friends ORDER BY added_at").all() as Array<{
    phone: string;
    name: string | null;
    added_at: number;
  }>;
}

export function isFriend(phone: string | null | undefined) {
  if (!phone) return false;
  let p: string;
  try {
    p = normalizePhone(phone);
  } catch {
    return false;
  }
  return getDb().query("SELECT 1 FROM friends WHERE phone = ?").get(p) !== null;
}

export function mute(phone: string, reason = "requested") {
  const p = normalizePhone(phone);
  getDb()
    .query("INSERT OR REPLACE INTO mutes (phone, reason, created_at) VALUES (?, ?, ?)")
    .run(p, reason, Date.now());
  return p;
}

export function unmute(phone: string) {
  return getDb().query("DELETE FROM mutes WHERE phone = ?").run(normalizePhone(phone)).changes;
}

export function isMuted(phone: string | null | undefined) {
  if (!phone) return false;
  let p: string;
  try {
    p = normalizePhone(phone);
  } catch {
    return false;
  }
  return getDb().query("SELECT 1 FROM mutes WHERE phone = ?").get(p) !== null;
}

export function listMutes() {
  return getDb().query("SELECT phone, reason, created_at FROM mutes ORDER BY created_at").all() as Array<{
    phone: string;
    reason: string | null;
    created_at: number;
  }>;
}

export function touchUser(phone: string) {
  const p = normalizePhone(phone);
  getDb()
    .query("INSERT INTO users (phone, last_seen) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET last_seen = excluded.last_seen")
    .run(p, Date.now());
}

export function createNudge(input: { phone: string; kind: NudgeKind; intent: string; sendAt: number }) {
  const p = normalizePhone(input.phone);
  const row = getDb()
    .query("INSERT INTO nudges (phone, kind, intent, send_at, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
    .run(p, input.kind, input.intent, input.sendAt, Date.now());
  return getDb().query("SELECT * FROM nudges WHERE id = ?").get(Number(row.lastInsertRowid)) as Nudge;
}

export function dueNudges(now: number) {
  return getDb()
    .query("SELECT * FROM nudges WHERE status = 'pending' AND send_at <= ? ORDER BY send_at")
    .all(now) as Nudge[];
}

/** Every pending nudge, due or not, for admin inspection. */
export function allPendingNudges() {
  return getDb()
    .query("SELECT * FROM nudges WHERE status = 'pending' ORDER BY send_at")
    .all() as Nudge[];
}

export function setNudgeStatus(id: number, status: NudgeStatus, sentAt: number | null = null) {
  getDb().query("UPDATE nudges SET status = ?, sent_at = ? WHERE id = ?").run(status, sentAt, id);
}

export function rescheduleNudge(id: number, sendAt: number) {
  getDb().query("UPDATE nudges SET send_at = ?, status = 'pending' WHERE id = ?").run(sendAt, id);
}

export function logSend(entry: {
  phone: string;
  kind: SendKind;
  status: SendStatus;
  detail?: string;
  body?: string;
  createdAt?: number;
}) {
  getDb()
    .query("INSERT INTO send_log (phone, kind, status, detail, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      normalizePhone(entry.phone),
      entry.kind,
      entry.status,
      entry.detail ?? null,
      entry.body ?? null,
      entry.createdAt ?? Date.now(),
    );
}

export function countSendsTo(phone: string, kind: SendKind, since: number) {
  const row = getDb()
    .query("SELECT COUNT(*) AS n FROM send_log WHERE phone = ? AND kind = ? AND status = 'sent' AND created_at >= ?")
    .get(normalizePhone(phone), kind, since) as { n: number };
  return row.n;
}

export function countSendsSince(since: number) {
  const row = getDb()
    .query("SELECT COUNT(*) AS n FROM send_log WHERE status = 'sent' AND created_at >= ?")
    .get(since) as { n: number };
  return row.n;
}
