// The server fills in {{version}} so a release installs a worker that replaces the old cache.
const VERSION = "{{version}}";
const CACHE = `oc-chat-${VERSION}`;
const SHELL = "/chat";
const STATIC = [
  "/assets/base.css",
  "/assets/icons.css",
  "/assets/fluent-icons.svg",
  "/assets/settings.css",
  "/assets/conversation.css",
  "/assets/recall.css",
  "/assets/attachments.css",
  "/assets/responsive.css",
  "/assets/code-highlight.css",
  "/assets/room-create.css",
  "/assets/edit-room.css",
  "/assets/palette.css",
  "/assets/files.css",
  "/assets/tasks.css",
  "/assets/doc-preview.css",
  "/assets/highlight-10.7.3.min.js",
  "/assets/marked-18.0.4.js",
  "/assets/dompurify-3.4.7.js",
  "/assets/mermaid-11.12.2.min.js",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/apple-touch-icon.png",
  "/manifest.webmanifest",
];
const VERSIONED = new Set(STATIC.filter((path) => path.endsWith(".css") || /^\/assets\/(?:highlight|marked|dompurify|mermaid)-/.test(path)));
const versioned = (path) => `${path}?v=${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Stylesheets and classic scripts carry the release version. A client still
    // running an older worker therefore misses its old cache after a deploy instead
    // of mixing new HTML with stale styles.
    await cache.addAll([SHELL, ...STATIC.map((path) => VERSIONED.has(path) ? versioned(path) : path)]);
    // The shell is a module graph, so an offline start needs the imports too. Walk them
    // from the entry point instead of keeping a list that drifts with every new module.
    const pending = ["/assets/chat/index.js"], seen = new Set();
    while (pending.length) {
      const url = pending.pop();
      if (seen.has(url)) continue;
      seen.add(url);
      const response = await fetch(url).catch(() => null);
      if (!response?.ok) continue;
      const source = await response.clone().text();
      await cache.put(url, response);
      for (const match of source.matchAll(/(?:from\s+"|import\(\s*")(\.\.?\/[^"]+\.js)"/g)) {
        pending.push(new URL(match[1], `https://chat.invalid${url}`).pathname);
      }
    }
    // A first install should control immediately. A replacement waits until the page
    // asks for it, so an open conversation is never reloaded without consent.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Chat data never comes from a cache: a stale answer would show a room that was deleted
  // and messages that were already read.
  if (url.pathname !== SHELL && !url.pathname.startsWith("/assets/")) return;
  if (url.pathname === SHELL) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) await (await caches.open(CACHE)).put(SHELL, response.clone());
        return response;
      } catch {
        return (await caches.match(SHELL)) || Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(async (response) => {
      if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
      return response;
    }).catch(() => cached || Response.error());
    return cached || network;
  })());
});
