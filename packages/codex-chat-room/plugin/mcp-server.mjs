#!/usr/bin/env node
// Codex plugin MCP entrypoint. Codex passes thread metadata on every tool call.
import { startServer } from "./lib/server.mjs";

startServer();