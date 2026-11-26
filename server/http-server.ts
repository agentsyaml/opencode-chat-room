// Compatibility shim: the HTTP adapter lives in src/platform so src code never
// imports from server/. Existing server-side imports may keep this path.
export * from "../src/platform/http-server.ts";