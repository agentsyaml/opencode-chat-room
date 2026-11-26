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
  "/assets/diagram-viewer.css",
  "/assets/chat/office-preview.js",
  "/assets/office/docx.bundle.js",
  "/assets/office/xlsx.bundle.js",
  "/assets/office/pptx.bundle.js",
  "/assets/marked-18.0.4.js",
  "/assets/dompurify-3.4.7.js",
  "/assets/mermaid-11.12.2.min.js",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/apple-touch-icon.png",
  "/manifest.webmanifest",
];
const VERSIONED = new Set(STATIC.filter((path) => path.endsWith(".css") || /^\/assets\/(?:marked|dompurify|mermaid)-/.test(path)));
const versioned = (path) => `${path}?v=${VERSION}`;

// Recently viewed images live in their own cache: a release upgrades CACHE, but a photo
// should survive until the person changes identity, it ages out, or the caps evict it.
const MEDIA_CACHE = "oc-chat-media";
const MEDIA_INDEX = "/__media-index__";
const MEDIA_IDENTITY = "/__media-identity__";
const MEDIA_PATH = /^\/rooms\/[^/]+\/resources\/[^/]+\/content$/;
const IDENTITY_PATTERN = /^[0-9a-f]{16}$/;
const REVALIDATE_MS = 10 * 60 * 1000;
const MEDIA_LIMITS = { entries: 80, bytes: 64 * 1024 * 1024, age: 30 * 24 * 60 * 60 * 1000 };
// Tests lower these numbers before seeding entries; production keeps the values above.
self.__MEDIA_LIMITS__ = MEDIA_LIMITS;

// The page owns the identity (a hash of its token and session ID); this worker only
// partitions the cache by it. Unknown identity means network-only.
let mediaIdentity;
let mediaQueue = Promise.resolve();
const queueMedia = (task) => {
  const run = mediaQueue.then(task, task);
  mediaQueue = run.catch(() => {});
  return run;
};

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
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  // The first message is a cheap moment to enforce the age policy even if the worker
  // was already active when this release first loaded.
  if (!self.__mediaPruned) {
    self.__mediaPruned = true;
    event.waitUntil(pruneMedia().catch(() => {}));
  }
  if (event.data?.type === "SET_MEDIA_IDENTITY") event.waitUntil(setMediaIdentity(event.data.identity).catch(() => {}));
  else if (event.data?.type === "CLEAR_MEDIA_CACHE") event.waitUntil(clearMedia().catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key !== MEDIA_CACHE && key.startsWith("oc-chat-")) await caches.delete(key);
    }
    await self.clients.claim();
  })());
  // Housekeeping must never delay or fail activation.
  event.waitUntil(pruneMedia().catch(() => {}));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (MEDIA_PATH.test(url.pathname)) {
    // Partial responses do not belong in a whole-body cache; leave ranges to the browser.
    if (request.headers.has("range")) return;
    event.respondWith(mediaResponse(event));
    return;
  }
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

// Cache Storage drops URL fragments, so the partition rides a reserved query parameter.
// The index keeps the readable `${url}#${identity}` form.
const mediaBodyKey = (url, identity) => `${url}${url.includes("?") ? "&" : "?"}__media_identity__=${identity}`;
const mediaIndexKey = (url, identity) => `${url}#${identity}`;

const isMediaEntry = (item) => Boolean(item)
  && typeof item.url === "string" && typeof item.key === "string" && typeof item.identity === "string"
  && Number.isFinite(item.size) && item.size >= 0
  && Number.isFinite(item.usedAt) && Number.isFinite(item.revalidatedAt);

const isCacheable = (response) => response.status !== 206
  && response.ok && response.type === "basic"
  && (response.headers.get("content-type") || "").startsWith("image/");

const tagged = (response, state) => {
  const headers = new Headers(response.headers);
  headers.set("X-Media-Cache", state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

async function loadMediaIdentity() {
  if (mediaIdentity !== undefined) return mediaIdentity;
  mediaIdentity = null;
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const response = await cache.match(MEDIA_IDENTITY);
    const value = response ? await response.json() : null;
    if (typeof value?.identity === "string" && IDENTITY_PATTERN.test(value.identity)) mediaIdentity = value.identity;
  } catch { /* No stored identity means network-only media. */ }
  return mediaIdentity;
}

async function saveMediaIdentity(identity) {
  const cache = await caches.open(MEDIA_CACHE);
  await cache.put(MEDIA_IDENTITY, new Response(JSON.stringify({ identity }), { headers: { "Content-Type": "application/json" } }));
}

async function setMediaIdentity(identity) {
  if (typeof identity !== "string" || !IDENTITY_PATTERN.test(identity)) return;
  await queueMedia(async () => {
    const previous = await loadMediaIdentity();
    mediaIdentity = identity;
    if (previous === identity) {
      await saveMediaIdentity(identity);
      return;
    }
    // A different browser identity must never read the previous one's cached images.
    await caches.delete(MEDIA_CACHE);
    await saveMediaIdentity(identity);
  });
}

async function clearMedia() {
  await queueMedia(async () => {
    const identity = await loadMediaIdentity();
    await caches.delete(MEDIA_CACHE);
    if (identity) await saveMediaIdentity(identity);
  });
}

async function readIndex(cache) {
  const response = await cache.match(MEDIA_INDEX);
  if (!response) return [];
  try {
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error("invalid index");
    return value.filter(isMediaEntry);
  } catch {
    // A damaged index cannot account for bodies; drop them so the caps stay meaningful.
    for (const request of await cache.keys()) {
      const path = new URL(request.url).pathname;
      if (path !== MEDIA_INDEX && path !== MEDIA_IDENTITY) await cache.delete(request);
    }
    await cache.delete(MEDIA_INDEX);
    return [];
  }
}

const writeIndex = (cache, items) => cache.put(MEDIA_INDEX, new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" } }));

async function applyLimits(cache, items) {
  const kept = [...items].sort((a, b) => a.usedAt - b.usedAt);
  let bytes = kept.reduce((sum, item) => sum + item.size, 0);
  const evicted = [];
  while (kept.length > MEDIA_LIMITS.entries || (bytes > MEDIA_LIMITS.bytes && kept.length)) {
    const item = kept.shift();
    bytes -= item.size;
    evicted.push(item);
  }
  for (const item of evicted) await cache.delete(mediaBodyKey(item.url, item.identity));
  await writeIndex(cache, kept);
}

async function storeMedia(url, identity, response) {
  const blob = await response.blob();
  await queueMedia(async () => {
    // An identity switch queued between fetch and put must not resurrect old bytes.
    if (mediaIdentity !== identity) return;
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(mediaBodyKey(url, identity), new Response(blob, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    }));
    const key = mediaIndexKey(url, identity), now = Date.now();
    const items = (await readIndex(cache)).filter((item) => item.key !== key);
    items.push({ key, url, identity, size: blob.size, usedAt: now, revalidatedAt: now });
    await applyLimits(cache, items);
  });
}

const touchMedia = (url, identity) => queueMedia(async () => {
  const cache = await caches.open(MEDIA_CACHE);
  const items = await readIndex(cache);
  const item = items.find((entry) => entry.url === url && entry.identity === identity);
  if (!item) return;
  item.usedAt = Date.now();
  await writeIndex(cache, items);
});

const revalidating = new Set();
function revalidateMedia(request, url, identity) {
  const key = mediaIndexKey(url, identity);
  if (revalidating.has(key)) return Promise.resolve();
  revalidating.add(key);
  return (async () => {
    try {
      const response = await fetch(request);
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        await queueMedia(async () => {
          const cache = await caches.open(MEDIA_CACHE);
          const items = await readIndex(cache);
          const kept = items.filter((item) => item.key !== key);
          await cache.delete(mediaBodyKey(url, identity));
          if (kept.length !== items.length) await writeIndex(cache, kept);
        });
      } else if (response.status === 200 && isCacheable(response)) {
        await storeMedia(url, identity, response);
      }
    } catch { /* A failed revalidation must not remove a working entry. */ }
    finally { revalidating.delete(key); }
  })();
}

async function pruneMedia() {
  await queueMedia(async () => {
    const cache = await caches.open(MEDIA_CACHE);
    const items = await readIndex(cache);
    const cutoff = Date.now() - MEDIA_LIMITS.age;
    const fresh = items.filter((item) => item.usedAt >= cutoff);
    for (const item of items) if (item.usedAt < cutoff) await cache.delete(mediaBodyKey(item.url, item.identity));
    await applyLimits(cache, fresh);
  });
}

async function mediaResponse(event) {
  try {
    return await serveMedia(event);
  } catch {
    // Cache Storage can be unavailable (private modes, quota). Media then stays network-only.
    try { return tagged(await fetch(event.request), "bypass"); }
    catch { return Response.error(); }
  }
}

async function serveMedia(event) {
  const request = event.request;
  const identity = await loadMediaIdentity();
  if (!identity) {
    try { return tagged(await fetch(request), "bypass"); }
    catch { return Response.error(); }
  }
  const url = request.url;
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(mediaBodyKey(url, identity));
  if (cached) {
    event.waitUntil(touchMedia(url, identity).catch(() => {}));
    const entry = (await readIndex(cache)).find((item) => item.key === mediaIndexKey(url, identity));
    // Serving stale is fine; revalidation is background hygiene for revocation/deletion.
    if (!entry || Date.now() - entry.revalidatedAt > REVALIDATE_MS) event.waitUntil(revalidateMedia(request, url, identity).catch(() => {}));
    return tagged(cached, "hit");
  }
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await storeMedia(url, identity, response.clone()).catch(() => {});
    return tagged(response, "miss");
  } catch {
    return Response.error();
  }
}