#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";

function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(path.resolve(here, candidate), "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version) return parsed.version;
    } catch {
      // Try the next layout.
    }
  }
  return "0.0.0";
}

const VERSION = readVersion();

const USAGE = `chat-room-channeld ${VERSION}

Relay chat-room events to external IM accounts through adapter child processes.

Usage:
  chat-room-channeld --config <path>         Run the relay host
  chat-room-channeld run --config <path>     Same as the default command
  chat-room-channeld check --config <path>   Validate a config file only
  chat-room-channeld status --config <path>  Print queue and integrity counts
  chat-room-channeld mock                    Run the mock adapter on stdio
  chat-room-channeld --version, -v           Print the version
  chat-room-channeld --help, -h              Print this help
`;

class UsageError extends Error {}

type Command = "run" | "check" | "status" | "mock";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`chat-room-channeld ${VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const rest = [...argv];
  let command: Command = "run";
  const first = rest[0];
  if (first === "run" || first === "check" || first === "status" || first === "mock") {
    command = rest.shift() as Command;
  }

  let configPath: string | undefined;
  while (rest.length > 0) {
    const arg = rest.shift() as string;
    if (arg === "--config") {
      const value = rest.shift();
      if (!value) throw new UsageError("--config requires a path");
      configPath = value;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      if (!configPath) throw new UsageError("--config requires a path");
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  if (command === "mock") {
    if (configPath) throw new UsageError("mock does not accept --config");
    const { runMockAdapter } = await import("./mock-adapter.ts");
    await runMockAdapter();
    return;
  }

  if (!configPath) throw new UsageError(`${command} requires --config <path>`);
  const config = loadConfig(configPath);
  if (command === "check") {
    process.stdout.write(`config ok: ${config.accounts.length} accounts, ${config.rules.length} rules\n`);
    return;
  }
  if (command === "status") {
    const { readChannelStats } = await import("./state.ts");
    process.stdout.write(`${JSON.stringify(readChannelStats(config.stateFile), null, 2)}\n`);
    return;
  }

  const { createHost } = await import("./host.ts");
  const host = createHost(config);
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void host.stop().then(() => {
      log.info("shutdown complete");
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await host.start();
  } catch (error) {
    await host.stop();
    throw error;
  }
  log.info(`relay running; state=${config.stateFile}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof UsageError ? 2 : 1;
  process.stderr.write(`chat-room-channeld: ${message}\n`);
  if (error instanceof UsageError) process.stderr.write(USAGE);
  process.exitCode = code;
});