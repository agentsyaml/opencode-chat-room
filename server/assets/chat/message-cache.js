// IndexedDB snapshots of joined rooms so a reopen renders from local history
// and only the delta comes from the server. Every failure degrades to the
// normal remote fetch; the cache never blocks the chat.
const DB_NAME = "chat-room-history";
const STORE = "rooms";
const CACHE_LIMIT = 2000;

let opening;
function open() {
  opening ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "roomId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
  return opening;
}

async function withStore(mode, run) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function loadCachedRooms() {
  try { return (await withStore("readonly", (store) => store.getAll())) || []; }
  catch { return []; }
}

export async function deleteCachedRoom(roomId) {
  try { await withStore("readwrite", (store) => store.delete(roomId)); } catch { /* optional cache */ }
}

const pending = new Map();
export function cacheRoomSoon(app, roomId) {
  if (pending.has(roomId)) return;
  pending.set(roomId, setTimeout(() => {
    pending.delete(roomId);
    const entry = app.state.rooms.get(roomId);
    if (!entry?.room) return;
    const snapshot = { ...entry.room, messages: entry.room.messages.slice(-CACHE_LIMIT) };
    void withStore("readwrite", (store) => store.put({ roomId, name: entry.name, savedAt: Date.now(), room: snapshot })).catch(() => {});
  }, 800));
}
