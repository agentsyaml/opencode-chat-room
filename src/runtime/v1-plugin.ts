import type { Config, Plugin, PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import type { V2Runtime } from "./v2-plugin.ts";
import type { QueueTransport } from "../center/queue-transport.ts";
import { fileURLToPath } from "node:url";
import { request } from "../center/center-client.ts";

const bundledSkillsPath = fileURLToPath(new URL("../../skills", import.meta.url));

export function createV1Server(deps: {
  runtime(input: PluginInput, transport: QueueTransport): V2Runtime;
  run<T>(runtime: V2Runtime, callback: () => T): T;
  room: ToolDefinition;
  admin?: ToolDefinition;
  observe(runtime: V2Runtime, sessionID: string): Promise<void>;
  checkInbox(runtime: V2Runtime, sessionID: string): Promise<void>;
  wake(runtime: V2Runtime, sessions: ReadonlySet<string>): Promise<void>;
  central: boolean;
  hasRooms?(runtime: V2Runtime, sessionID: string): Promise<boolean>;
}) : Plugin {
  return async (input) => {
    const sessions = new Set<string>();
    const transport = {
      serverUrl: String(input.serverUrl),
      directory: input.directory,
      protocol: "v1" as const,
    };
    const runtime = deps.runtime(input, transport);
    const adminTool = deps.admin;
    const hasRooms = deps.hasRooms ?? (async (runtime: V2Runtime, sessionID: string) => {
      const rooms = await request(runtime.center, `/rooms?sessionID=${encodeURIComponent(sessionID)}`, "GET");
      return Array.isArray(rooms) && rooms.length > 0;
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    if (deps.central) {
      const sweep = (pollInbox: boolean) => void deps.run(runtime, async () => {
        await deps.wake(runtime, sessions).catch(() => {});
        if (!pollInbox) return;
        for (const sessionID of [...sessions]) await deps.checkInbox(runtime, sessionID).catch(() => {});
      });
      sweep(false);
      timer = setInterval(() => sweep(true), 10000);
    }
    const room = {
      ...deps.room,
        execute: (args: Parameters<ToolDefinition["execute"]>[0], context: Parameters<ToolDefinition["execute"]>[1]) =>
        deps.run(runtime, async () => {
          sessions.add(context.sessionID);
          await deps.observe(runtime, context.sessionID);
          return deps.room.execute(args, context);
        }),
    };
    return {
      tool: { room, ...(adminTool ? { admin: {
        ...adminTool,
        execute: (args, context) => deps.run(runtime, () => adminTool.execute(args, context)),
      } } : {}) },
      config: async (cfg: Config & { skills?: { paths?: string[]; urls?: string[] } }) => {
        cfg.skills ??= {};
        cfg.skills.paths = [...new Set([...(cfg.skills.paths ?? []), bundledSkillsPath])];
        cfg.command = cfg.command ?? {};
        cfg.command.room = {
          description: "Chat room: create/join/leave/list rooms, send and poll messages",
          template: "Use the room tool to handle the chat room command. Arguments: $ARGUMENTS",
        };
      },
      dispose: async () => { if (timer) clearInterval(timer); },
      // A session that belongs to a room must ask there, where the question is recorded
      // and every member sees it. Questions asked through the host dialog reach one person.
      "tool.execute.before": async (hook: { tool: string; sessionID: string }) => {
        if (hook.tool !== "question") return;
        let member = false;
        try {
          member = await deps.run(runtime, () => hasRooms(runtime, hook.sessionID));
        } catch {
          return; // A center that cannot answer must not block the agent's tooling.
        }
        if (member) throw new Error("Do not ask through the host dialog while this session belongs to a room. Send the question in the room instead: room tool, action send, isQuestion true, with the room ID and enough context for the human to answer.");
      },
      "chat.message": async (event: { sessionID: string }) => {
        sessions.add(event.sessionID);
        await deps.run(runtime, async () => {
          await deps.observe(runtime, event.sessionID);
          if (deps.central) void deps.checkInbox(runtime, event.sessionID).catch(() => {});
        });
      },
    };
  };
}
