import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

test("concurrent startup drops deferred background retry rows and initializes attempt claims", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "receiver-state-init-"));
  const stateHome = path.join(root, "state");
  const directory = path.join(stateHome, "opencode", "chat-room");
  mkdirSync(directory, { recursive: true });
  const db = new Database(path.join(directory, "receiver.sqlite"), { create: true });
    db.exec("CREATE TABLE pending_admissions(session_id TEXT NOT NULL,room_id TEXT NOT NULL,admission TEXT NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(session_id,room_id)); INSERT INTO pending_admissions VALUES('session','room','{\"id\":\"old-id\",\"maxTs\":123}',9999999999999,1); CREATE TABLE background_attempts(session_id TEXT NOT NULL,room_id TEXT NOT NULL,admission_id TEXT NOT NULL,service TEXT NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(session_id,room_id,admission_id)); INSERT INTO background_attempts VALUES('session','room','old-id','service',9999999999999,1); INSERT INTO background_attempts VALUES('session','ambiguous-room','unknown-id','service',9999999999999,1); CREATE TABLE background_retries(session_id TEXT NOT NULL,room_id TEXT NOT NULL,service TEXT NOT NULL,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL,trigger_ts INTEGER NOT NULL,PRIMARY KEY(session_id,room_id)); INSERT INTO background_retries VALUES('session','old-room','retry-service',1,9999999999999,456); INSERT INTO background_retries VALUES('session','ambiguous-retry','retry-service',1,9999999999999,0)");
  db.close();
  const moduleURL = new URL("./receiver-state.ts", import.meta.url).href;
   const source = `const state=await import(${JSON.stringify(moduleURL)});state.claimBackgroundAttempt("session","init-room","init-service",1);state.closeReceiverState();console.log("initialized")`;
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, XDG_STATE_HOME: stateHome };
  try {
    const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", source], {
      env, stdout: "pipe", stderr: "pipe",
    }));
    const results = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })));
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, stdout: "initialized\n", stderr: "" })));
    const verify = new Database(path.join(directory, "receiver.sqlite"));
     expect(verify.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('background_retries','background_attempts')").all()).toEqual([]);
     expect(verify.query("SELECT room_id,service,through_ts FROM background_attempted_through ORDER BY room_id").all()).toEqual([
       { room_id: "ambiguous-retry", service: "retry-service", through_ts: Number.MAX_SAFE_INTEGER },
       { room_id: "ambiguous-room", service: "service", through_ts: Number.MAX_SAFE_INTEGER },
       { room_id: "init-room", service: "init-service", through_ts: 1 },
       { room_id: "old-room", service: "retry-service", through_ts: 456 },
       { room_id: "room", service: "service", through_ts: 123 },
     ]);
    verify.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
