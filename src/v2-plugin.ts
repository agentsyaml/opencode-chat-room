import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import type { QueueTransport } from "./center-client";

type CenterOptions = { center: string; token: string; directory: string };
export type V2Runtime = {
  protocol: "v1" | "v2";
  selfServerUrl: string;
  selfDirectory: string;
  transport: QueueTransport;
  center: CenterOptions;
};

export function createV2Setup(deps: {
  runtime(directory: string, transport: QueueTransport): V2Runtime;
  run<T>(runtime: V2Runtime, callback: () => T): T;
  execute(args: z.infer<ReturnType<typeof roomSchema>>, sessionID: string): Promise<string>;
  observe(runtime: V2Runtime, sessionID: string): Promise<void>;
  poll(sessions: ReadonlySet<string>, transport: QueueTransport, center: CenterOptions): Promise<void>;
  wake(center: CenterOptions, transport: QueueTransport, sessions: ReadonlySet<string>): Promise<void>;
  central: boolean;
}) {
  return async (context: Plugin.Context): Promise<() => Promise<void>> => {
    const sessions = new Set<string>();
    const directory = context.location.directory;
    const transport: QueueTransport = {
      directory,
      protocol: "v2",
      promptQueue: (sessionID, id, text) => context.session.prompt({
        sessionID, id, text, delivery: "queue", resume: true,
      }),
    };
    const runtime = deps.runtime(directory, transport);
    let toolRegistration: { dispose(): Promise<void> } | undefined;
    let commandRegistration: { dispose(): Promise<void> } | undefined;
    let promptRegistration: { dispose(): Promise<void> } | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let wakeTimer: ReturnType<typeof setInterval> | undefined;
    let polling = false;
    let stopped = false;
    const poll = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        await deps.run(runtime, () => deps.poll(sessions, transport, runtime.center));
      } catch {
        // Retry transient polling failures on the next interval.
      } finally {
        polling = false;
      }
    };

    try {
      promptRegistration = await context.session.hook("prompt", async (input) => {
        sessions.add(input.sessionID);
        await deps.run(runtime, () => deps.observe(runtime, input.sessionID));
      });
      toolRegistration = await context.tool.transform((editor) => editor.add({
        name: "room",
        description: "Chat room operations: create, join, leave and list rooms; send and poll messages; list members",
        options: { codemode: false },
        input: roomSchema(),
        execute: async (args, toolContext) => {
          sessions.add(toolContext.sessionID);
          return deps.run(runtime, async () => {
            await deps.observe(runtime, toolContext.sessionID);
            return { content: [{ type: "text", text: await deps.execute(args, toolContext.sessionID) }] };
          });
        },
      }));
      commandRegistration = await context.command.transform((editor) => editor.add({
        name: "room",
        description: "Chat room operations",
        execute: async ({ sessionID, prompt, delivery }) => {
          sessions.add(sessionID);
          await deps.run(runtime, () => deps.observe(runtime, sessionID));
          await context.session.prompt({
            sessionID,
            text: `${prompt.text}\n\nThe user invoked /room. Use the room tool to perform this command.`,
            files: prompt.files,
            agents: prompt.agents,
            skills: prompt.skills,
            delivery,
          });
        },
      }));
      pollTimer = setInterval(() => void poll(), 5000);
      if (deps.central) {
        const wake = () => deps.run(runtime, () => deps.wake(runtime.center, transport, sessions)).catch(() => {});
        void wake();
        wakeTimer = setInterval(() => void wake(), 10000);
      }
    } catch (error) {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (wakeTimer) clearInterval(wakeTimer);
      await dispose(toolRegistration, commandRegistration, promptRegistration);
      throw error;
    }
    return async () => {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (wakeTimer) clearInterval(wakeTimer);
      await dispose(toolRegistration, commandRegistration, promptRegistration);
    };
  };
}

function roomSchema() {
  return z.object({
    action: z.enum(["create", "join", "leave", "list", "send", "poll", "members"]),
    name: z.string().max(64).optional(),
    roomId: z.string().optional(),
    text: z.string().max(2000).optional(),
  });
}

async function dispose(...registrations: ({ dispose(): Promise<void> } | undefined)[]) {
  await Promise.all(registrations.map((registration) => registration?.dispose()));
}
