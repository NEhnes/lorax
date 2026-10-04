import fs from "fs/promises";
import path from "path";

export type Claim = { text: string; source_url: string };
export type Dossier = { id: string; company: string; claims: Claim[]; created_at: number };

const DIR = path.resolve(process.cwd(), "data", "dossiers");

async function ensureDir() {
  try {
    await fs.mkdir(DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

export async function saveDossier(company: string, claims: Claim[]) {
  await ensureDir();
  const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  const d: Dossier = { id, company, claims, created_at: Date.now() };
  const file = path.join(DIR, `${id}.json`);
  await fs.writeFile(file, JSON.stringify(d, null, 2), "utf8");
  return id;
}

export async function getDossier(id: string) {
  await ensureDir();
  const file = path.join(DIR, `${id}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as Dossier;
  } catch (e) {
    return null;
  }
}
