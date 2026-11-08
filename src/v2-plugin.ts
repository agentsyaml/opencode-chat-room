import type { Skill, Plugin } from "@opencode/plugin";
import { z } from "zod";
import type { QueueTransport } from "./center-client";
import { backgroundOwnSession, discoverVerifiedHost, verifyHostSession } from "./background";
import { receiverOwnerID } from "./receiver-owner";
import { attachV2Receiver } from "./v2-receiver";
import { observeReceiptContext, receiptDestination } from "./agent-receipts";
import { chatroomSkill } from "./chatroom-skill";

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
  execute(args: z.infer<ReturnType<typeof roomSchema>>, sessionID: string, permissionContext: { directory: string; worktree?: string; ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }): Promise<void> }): Promise<string>;
  observe(runtime: V2Runtime, sessionID: string): Promise<void>;
  poll(sessions: ReadonlySet<string>, transport: QueueTransport, center: CenterOptions): Promise<void>;
  resolveOwner?: () => Promise<string | undefined>;
  attachReceiver?: typeof attachV2Receiver;
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
    let contextRegistration: { dispose(): Promise<void> } | undefined;
    let skillRegistration: { dispose(): Promise<void> } | undefined;
    let releaseReceiver: (() => void) | undefined;

    try {
      skillRegistration = await context.skill.transform((editor) => {
        if (!editor.get(chatroomSkill.id)) editor.add({
          ...chatroomSkill,
          id: chatroomSkill.id as Skill.ID,
          name: chatroomSkill.name as Skill.Name,
          path: chatroomSkill.path as Skill.Info["path"],
        });
      });
      promptRegistration = await context.session.hook("prompt", async (input) => {
        sessions.add(input.sessionID);
        await deps.run(runtime, () => deps.observe(runtime, input.sessionID));
      });
      contextRegistration = await context.session.hook("context", async (input) => {
        try {
          if (!transport.receiverOwnerID) {
            if (deps.resolveOwner) transport.receiverOwnerID = await deps.resolveOwner();
            else if (version) {
              const host = await discoverVerifiedHost(version).catch(() => undefined);
              if (host) transport.receiverOwnerID = await receiverOwnerID(host.origin);
            }
          }
          if (transport.receiverOwnerID) observeReceiptContext(input.sessionID, input.messages,
            receiptDestination(runtime.center.center), transport.receiverOwnerID);
        } catch { /* Context evidence never fails model preparation. */ }
      });
      toolRegistration = await context.tool.transform((editor) => editor.add({
        name: "room",
        description: "Chat room operations: create, join, leave and list rooms; send and poll messages; list members and announcements; upload files and media",
        options: { codemode: false },
        input: roomSchema(),
        execute: async (args, toolContext) => {
          sessions.add(toolContext.sessionID);
          return deps.run(runtime, async () => {
            await deps.observe(runtime, toolContext.sessionID);
            const permissionContext = {
              directory: context.location.directory,
              worktree: context.location.directory,
              ask: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => context.permission.assert({
                sessionID: toolContext.sessionID,
                agent: toolContext.agent,
                action: input.permission,
                resources: input.patterns,
                save: input.always,
                metadata: input.metadata,
                source: { type: "tool", messageID: toolContext.messageID, id: toolContext.id },
              }),
            };
            return { content: [{ type: "text", text: await deps.execute(args, toolContext.sessionID, permissionContext) }] };
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
      const attachReceiver = deps.attachReceiver ?? attachV2Receiver;
      releaseReceiver = attachReceiver({
        sessions, version, transport, center: runtime.center,
        poll: (ids, target, center) => {
          if (target.receiverOwnerID) transport.receiverOwnerID = target.receiverOwnerID;
          return deps.run(runtime, () => deps.poll(ids, target, center));
        },
      });
    } catch (error) {
      releaseReceiver?.();
      await dispose(toolRegistration, commandRegistration, promptRegistration, contextRegistration, skillRegistration);
      throw error;
    }
    return async () => {
      releaseReceiver?.();
      await dispose(toolRegistration, commandRegistration, promptRegistration, contextRegistration, skillRegistration);
    };
  };
}

function roomSchema() {
  return z.object({
    action: z.enum(["create", "join", "leave", "list", "send", "poll", "members", "upload_resource", "announcement_list", "announcement_read", "announcement_write", "announcement_delete"]),
    name: z.string().max(64).optional().describe("For join: your own participant display name, NOT the room name (required). For create: the new room name."),
    roomId: z.string().optional(),
    filePath: z.string().optional().describe("Local regular file to upload; central mode only; requires host read permission."),
    text: z.string().max(2000).optional(),
    isQuestion: z.boolean().optional(),
    announcementName: z.string().optional().describe("Name of a room announcement; distinct from participant or room name."),
    content: z.string().optional().describe("Announcement content, at most 5000 Unicode characters."),
  }).superRefine((args, ctx) => {
    if (args.action === "join" && !args.name?.trim()) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "name is required to join a room" });
    }
  });
}

async function dispose(...registrations: ({ dispose(): Promise<void> } | undefined)[]) {
  await Promise.all(registrations.map((registration) => registration?.dispose()));
}
