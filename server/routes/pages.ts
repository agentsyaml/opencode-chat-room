// Static pages and assets served before the JSON API auth gate.
import { promises as fs } from "node:fs";
import path from "node:path";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// The chat page shows this next to the app title; a missing package must not
// leave a placeholder behind.
let versionTag: Promise<string> | undefined;
function chatVersionTag(here: string): Promise<string> {
  return (versionTag ??= fs.readFile(path.join(here, "../package.json"), "utf8")
    .then((text) => {
      const pkg = JSON.parse(text) as { version?: unknown };
      return typeof pkg?.version === "string" && pkg.version ? `v${pkg.version}` : "";
    })
    .catch(() => ""));
}

export async function pageRoutes(
  req: Request,
  url: URL,
  here: string,
  channeld: boolean,
): Promise<Response | undefined> {
  const p = url.pathname;
  if (req.method === "GET" && p === "/") {
    return Response.redirect(new URL("/chat", url).toString(), 302);
  }
  if (req.method === "GET" && p === "/chat") {
    const html = await fs
      .readFile(path.join(here, "chat.html"), "utf8")
      .catch(() => null);
    if (html === null) {
      return json({ error: "chat page not found" }, 404);
    }
    const version = await chatVersionTag(here);
    return new Response(html.replaceAll("{{version}}", version)
        .replaceAll("{{channeld}}", channeld ? "on" : "off")
        .replaceAll("{{integrationsAdmin}}", process.env.CHATROOM_ALLOW_ADMIN === "true" ? "true" : "false"), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  // The install surface lives at the origin root so the worker controls /chat, not /assets.
  if (req.method === "GET" && p === "/manifest.webmanifest") {
    const body = await fs.readFile(path.join(here, "manifest.webmanifest"), "utf8").catch(() => null);
    if (body === null) return json({ error: "manifest not found" }, 404);
    return new Response(body, {
      headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (req.method === "GET" && p === "/sw.js") {
    const body = await fs.readFile(path.join(here, "sw.js"), "utf8").catch(() => null);
    if (body === null) return json({ error: "service worker not found" }, 404);
    const version = (await chatVersionTag(here)) || "dev";
    return new Response(body.replaceAll("{{version}}", version), {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Service-Worker-Allowed": "/",
      },
    });
  }
  if (req.method === "GET" && p.startsWith("/assets/")) {
    let relative: string;
    try { relative = decodeURIComponent(p.slice("/assets/".length)); }
    catch { return json({ error: "invalid asset path" }, 400); }
    const root = path.resolve(here, "assets");
    const file = path.resolve(root, relative);
    if (!relative || !file.startsWith(`${root}${path.sep}`) || !/\.(?:css|js|mjs|svg|png|jpg|ttf|woff2?)$/i.test(file)) return json({ error: "not found" }, 404);
    const data = await fs.readFile(file).catch(() => null);
    if (!data) return json({ error: "not found" }, 404);
    const type = file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : /\.(?:js|mjs)$/.test(file) ? "text/javascript" : file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : file.endsWith(".ttf") ? "font/ttf" : "font/woff2";
    return new Response(data, { headers: { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  return undefined;
}