import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const validID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isReceiverOwnerID = (value: unknown): value is string => typeof value === "string" && validID.test(value);

export async function receiverOwnerID(origin: string): Promise<string | undefined> {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const root = path.join(base, "opencode", "chat-room");
  const dir = path.join(root, "owners");
  const name = createHash("sha256").update(new URL(origin).origin).digest("hex") + ".json";
  const file = path.join(dir, name);
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as { ownerID?: string };
      return typeof value.ownerID === "string" && validID.test(value.ownerID) ? value.ownerID : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const ownerID = randomUUID();
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ ownerID }), { flag: "wx", mode: 0o600 });
    try { await fs.link(temp, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    } finally { await fs.unlink(temp).catch(() => {}); }
    const value = JSON.parse(await fs.readFile(file, "utf8")) as { ownerID?: string };
    return typeof value.ownerID === "string" && validID.test(value.ownerID) ? value.ownerID : undefined;
  } catch {
    return undefined;
  }
}
