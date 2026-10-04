import fs from "fs";
import path from "path";
import {
  addFriend,
  allPendingNudges,
  listFriends,
  listMutes,
  mute,
  removeFriend,
  unmute,
  type NudgeKind,
} from "./store";
import { createNudge } from "./prank";

const ENV_PATH = path.resolve(process.cwd(), ".env");

const USAGE = `Lorax Hotline admin

  bun run cli add-friend +15551234567 [name]   allowlist a friend for prank mode
  bun run cli remove-friend +1555...          drop a friend from the allowlist
  bun run cli mute +15551234567 [reason]      stop all contact, permanently
  bun run cli unmute +15551234567             lift a mute
  bun run cli list                            show friends, mutes, pending nudges
  bun run cli nudge +1555... opener|followup "intent" [delay_min]
  bun run cli dry-run on|off                  flip DRY_RUN in .env`;

function setEnvValue(key: string, value: string) {
  let current = "";
  try {
    current = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    // no .env yet; start from scratch
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(current) ? current.replace(re, line) : `${current.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV_PATH, next.trimStart(), "utf8");
  return line;
}

function printDossiers() {
  const dir = path.resolve(process.cwd(), "data", "dossiers");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  console.log(`dossiers: ${files.length}`);
  for (const f of files.slice(-5)) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      console.log(`  ${d.company} (${d.claims?.length ?? 0} claims)`);
    } catch {
      console.log(`  ${f} (unreadable)`);
    }
  }
}

const [command, ...args] = process.argv.slice(2);

/** Turn store validation errors into a one-line message instead of a stack trace. */
function attempt<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e: any) {
    console.error(`${label}: ${e?.message ?? String(e)}`);
    process.exit(1);
  }
}

switch (command) {
  case "add-friend": {
    if (!args[0]) {
      console.error("usage: bun run cli add-friend <phone> [name]");
      process.exit(1);
    }
    const p = attempt("add-friend", () => addFriend(args[0], args[1]));
    console.log(`allowlisted ${p}`);
    break;
  }
  case "remove-friend": {
    const removed = attempt("remove-friend", () => removeFriend(args[0] ?? ""));
    console.log(removed ? `removed ${args[0]}` : `${args[0]} was not allowlisted`);
    break;
  }
  case "mute": {
    if (!args[0]) {
      console.error("usage: bun run cli mute <phone> [reason]");
      process.exit(1);
    }
    console.log(`muted ${attempt("mute", () => mute(args[0], args[1] ?? "admin"))}`);
    break;
  }
  case "unmute": {
    const removed = attempt("unmute", () => unmute(args[0] ?? ""));
    console.log(removed ? `unmuted ${args[0]}` : `${args[0]} was not muted`);
    break;
  }
  case "list": {
    const friends = listFriends();
    console.log(`friends (${friends.length}):`);
    for (const f of friends) console.log(`  ${f.phone}${f.name ? `  ${f.name}` : ""}`);
    const mutes = listMutes();
    console.log(`mutes (${mutes.length}):`);
    for (const m of mutes) console.log(`  ${m.phone}  ${m.reason ?? ""}`);
    const pending = allPendingNudges();
    console.log(`pending nudges (${pending.length}):`);
    for (const n of pending) {
      console.log(`  ${n.phone}  ${n.kind}  ${new Date(n.send_at).toLocaleString()}  ${n.intent}`);
    }
    printDossiers();
    break;
  }
  case "nudge": {
    const [phone, kind, intent, delayMin] = args;
    if (!phone || !intent || (kind !== "opener" && kind !== "followup")) {
      console.error('usage: bun run cli nudge <phone> opener|followup "intent" [delay_min]');
      process.exit(1);
    }
    const delay = Number(delayMin ?? 0);
    const nudge = attempt("nudge", () =>
      createNudge({
        phone,
        kind: kind as NudgeKind,
        intent,
        sendAt: Date.now() + (Number.isFinite(delay) ? delay : 0) * 60_000,
      }),
    );
    if (!nudge) break;
    console.log(`nudge ${nudge.id} -> ${nudge.phone} at ${new Date(nudge.send_at).toLocaleString()}`);
    break;
  }
  case "dry-run": {
    const on = args[0] !== "off";
    console.log(setEnvValue("DRY_RUN", on ? "true" : "false"));
    break;
  }
  default: {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
}
