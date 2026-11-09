import type { Config, Plugin, PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import type { V2Runtime } from "./v2-plugin";
import type { QueueTransport } from "./queue-transport";
import { fileURLToPath } from "node:url";

const bundledSkillsPath = fileURLToPath(new URL("../skills", import.meta.url));

export function createV1Server(deps: {
  runtime(input: PluginInput, transport: QueueTransport): V2Runtime;
  run<T>(runtime: V2Runtime, callback: () => T): T;
  room: ToolDefinition;
  admin?: ToolDefinition;
  observe(runtime: V2Runtime, sessionID: string): Promise<void>;
  checkInbox(runtime: V2Runtime, sessionID: string): Promise<void>;
  wake(runtime: V2Runtime, sessions: ReadonlySet<string>): Promise<void>;
  central: boolean;
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
