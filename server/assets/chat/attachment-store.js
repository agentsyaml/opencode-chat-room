// Durable recovery for pasted attachments. Text is written synchronously so it
// survives the same task that creates the file; other blobs use IndexedDB.
const DB_NAME = "oc-chat-attachments", STORE = "pending", TEXT_PREFIX = "chat.pendingText:";
let dbPromise;

function database() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}
function done(request) {
  return new Promise((resolve) => { request.onsuccess = () => resolve(request.result); request.onerror = () => resolve(undefined); });
}
function committed(tx) {
  return new Promise((resolve) => { tx.oncomplete = () => resolve(true); tx.onerror = tx.onabort = () => resolve(false); });
}
async function write(record) {
  const db = await database(); if (!db) return false;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    return await committed(tx);
  } catch { return false; }
}
async function remove(key) {
  const db = await database(); if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    await committed(tx);
  } catch { /* Best effort; stale blobs are harmless. */ }
}
function readTexts() {
  const records = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(TEXT_PREFIX)) continue;
      try { records.push(JSON.parse(localStorage.getItem(key) || "null")); } catch { /* Ignore one damaged record. */ }
    }
  } catch { /* Storage may be blocked. */ }
  return records.filter((record) => record && typeof record.key === "string");
}
function writeText(record) {
  try { localStorage.setItem(TEXT_PREFIX + record.key, JSON.stringify(record)); return true; }
  catch { return false; }
}
function forgetText(key) {
  try { localStorage.removeItem(TEXT_PREFIX + key); } catch { /* Storage may be blocked. */ }
}

export function persist(item, roomId) {
  const record = {
    key: item.uploadID, roomId, name: item.file.name, textSource: item.textSource,
    type: item.file.type, lastModified: item.file.lastModified, createdAt: Date.now(),
  };
  if (typeof item.textContent === "string" && writeText({ ...record, text: item.textContent })) {
    item.durable = true;
    return Promise.resolve(true);
  }
  item.persist = write({ ...record, blob: item.file }).then((ok) => { item.durable = ok; return ok; });
  return item.persist;
}

export function forget(item) {
  forgetText(item.uploadID);
  void Promise.resolve(item.persist).finally(() => remove(item.uploadID));
}

export function forgetTextSource(roomId, textSource) {
  for (const record of readTexts()) if (record.roomId === roomId && record.textSource === textSource) forgetText(record.key);
}

export async function recover(roomId, draft) {
  const texts = readTexts().filter((record) => record.roomId === roomId);
  const files = (await readFiles()).filter((record) => record.roomId === roomId);
  const seen = new Set(), restored = [];
  for (const record of [...texts, ...files]) {
    if (seen.has(record.key)) continue;
    seen.add(record.key);
    if (record.textSource !== undefined && record.textSource === draft) { forgetText(record.key); void remove(record.key); continue; }
    try {
      const content = typeof record.text === "string" ? record.text : record.blob;
      const file = new File([content], record.name, { type: record.type || "text/plain", lastModified: record.lastModified });
      restored.push({ file, uploadID: record.key, textSource: record.textSource, textContent: record.text });
    } catch { /* Skip a damaged record instead of failing the whole restore. */ }
  }
  return restored;
}

async function readFiles() {
  const db = await database(); if (!db) return [];
  try {
    const tx = db.transaction(STORE, "readonly");
    const result = await done(tx.objectStore(STORE).getAll());
    return Array.isArray(result) ? result : [];
  } catch { return []; }
}

