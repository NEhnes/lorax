import fs from "fs";
import path from "path";
import { listMutes, mute, unmute } from "./store";

const ENV_PATH = path.resolve(process.cwd(), ".env");

const USAGE = `Lorax Hotline admin

  bun run cli mute +15551234567 [reason]      stop all contact, permanently
  bun run cli unmute +15551234567             lift a mute
  bun run cli list                            show mutes and dossiers
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
    const mutes = listMutes();
    console.log(`mutes (${mutes.length}):`);
    for (const m of mutes) console.log(`  ${m.phone}  ${m.reason ?? ""}`);
    printDossiers();
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
