import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, chmod, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { statePath } from "./store";

export type AdminIdentity = { center: string; roomId: string; sessionID: string; ownerID: string };
const keyOf = (identity: AdminIdentity) => createHash("sha256").update(JSON.stringify([
  new URL(identity.center).origin, identity.roomId, identity.sessionID, identity.ownerID,
])).digest("hex");

function credentialPath(identity: AdminIdentity): string {
  return path.join(path.dirname(statePath()), "admin-capabilities", `${keyOf(identity)}.json`);
}
async function persist(file: string, content: unknown): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(content), { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

export async function loadAdminCapability(identity: AdminIdentity): Promise<string | undefined> {
  try {
    const file = credentialPath(identity);
    const content = JSON.parse(await readFile(file, "utf8")) as { capability?: unknown; origin?: unknown };
    return content.origin === new URL(identity.center).origin && typeof content.capability === "string"
      ? content.capability : undefined;
  } catch { return undefined; }
}

export async function saveAdminCapability(identity: AdminIdentity, capability: string): Promise<void> {
  const file = credentialPath(identity);
  await persist(file, { origin: new URL(identity.center).origin, capability });
}
