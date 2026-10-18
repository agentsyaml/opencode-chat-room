import type { Config, Plugin, PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import type { V2Runtime } from "./v2-plugin";
import type { QueueTransport } from "./queue-transport";

export function createV1Server(deps: {
  runtime(input: PluginInput, transport: QueueTransport): V2Runtime;
  run<T>(runtime: V2Runtime, callback: () => T): T;
  room: ToolDefinition;
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
    let timer: ReturnType<typeof setInterval> | undefined;
    if (deps.central) {
      void deps.run(runtime, () => deps.wake(runtime, sessions));
      timer = setInterval(() => void deps.run(runtime, () => deps.wake(runtime, sessions)), 10000);
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
      tool: { room },
      config: async (cfg: Config) => {
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
