import { expect, test } from "bun:test";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

test("the service worker precaches every shipped stylesheet and top-level asset", async () => {
  const root = process.cwd();
  const worker = await readFile(path.join(root, "server/sw.js"), "utf8");
  const block = worker.match(/const STATIC = \[([\s\S]*?)\];/)?.[1] ?? "";
  const listed = new Set([...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? ""));

  const css = (await readdir(path.join(root, "server/assets")))
    .filter((name) => name.endsWith(".css"))
    .map((name) => `/assets/${name}`);
  expect(css.length).toBeGreaterThan(0);
  for (const file of css) expect(listed.has(file)).toBe(true);

  // A stale STATIC entry makes cache.addAll reject the whole install.
  for (const file of listed) await access(path.join(root, "server", file));

  const html = await readFile(path.join(root, "server/chat.html"), "utf8");
  const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1] ?? "");
  const linked = links
    .map((link) => link.replace(/[?#].*$/, ""))
    .filter((file) => file.startsWith("/assets/") && !file.startsWith("/assets/chat/"));
  expect(linked.length).toBeGreaterThan(0);
  for (const file of linked) expect(listed.has(file)).toBe(true);
  // CSS and vendor scripts must carry the version or an old worker can serve stale bytes.
  for (const link of links.filter((value) => value.startsWith("/assets/"))) {
    const file = link.replace(/\?.*$/, "");
    if (!file.endsWith(".css") && !/^\/assets\/(?:highlight|marked|dompurify|mermaid)-/.test(file)) continue;
    expect(link.endsWith("?v={{version}}")).toBe(true);
  }
});