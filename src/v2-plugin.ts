import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import type { QueueTransport } from "./center-client";
import { backgroundOwnSession, discoverVerifiedHost, verifyHostSession } from "./background";
import { receiverOwnerID } from "./receiver-owner";
import { attachV2Receiver } from "./v2-receiver";

type CenterOptions = { center: string; token: string; directory?: string };
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
}) {
  return async (context: Plugin.Context): Promise<() => Promise<void>> => {
    const sessions = new Set<string>();
    const directory = context.location.directory;
    const version = context.app?.version ?? "";
    const host = version ? await discoverVerifiedHost(version).catch(() => undefined) : undefined;
    const ownerID = host ? await receiverOwnerID(host.origin) : undefined;
    const transport: QueueTransport = {
      directory,
      protocol: "v2",
      receiverOwnerID: ownerID,
      verifySession: (sessionID) => verifyHostSession(sessionID, version),
      backgroundSession: (sessionID) => backgroundOwnSession(sessionID, version),
      promptQueue: (sessionID, id, text, delivery) => context.session.prompt({
        sessionID, id, text, delivery, resume: true,
      }),
    };
    const runtime = deps.runtime(directory, transport);
    let toolRegistration: { dispose(): Promise<void> } | undefined;
    let commandRegistration: { dispose(): Promise<void> } | undefined;
    let promptRegistration: { dispose(): Promise<void> } | undefined;
    let releaseReceiver: (() => void) | undefined;

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
      releaseReceiver = attachV2Receiver({
        sessions, version, transport, center: runtime.center,
        poll: (ids, target, center) => deps.run(runtime, () => deps.poll(ids, target, center)),
      });
    } catch (error) {
      releaseReceiver?.();
      await dispose(toolRegistration, commandRegistration, promptRegistration);
      throw error;
    }
    return async () => {
      releaseReceiver?.();
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
