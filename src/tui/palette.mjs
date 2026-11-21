// Pure command palette logic: command lists, scoped client-side search,
// ranking and snippets. No I/O lives here so it is easy to test.

const SEARCH_LIMIT = 50;

export function filterCommands(commands, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return commands.slice();
  return commands.filter((command) => command.label.toLowerCase().includes(needle));
}

/** Commands shown when the palette query is empty. */
export function buildCommands({ rooms = [], current = null, joined = false, help = false } = {}) {
  const commands = [
    { id: "refresh", label: "Refresh rooms" },
    { id: "new-room", label: "New room..." },
  ];
  for (const room of rooms) {
    if (!room.joined) commands.push({ id: `join:${room.id}`, label: `Join #${room.name}`, roomId: room.id });
  }
  if (current && joined) commands.push({ id: "leave-room", label: `Leave #${current.name}` });
  commands.push({ id: "toggle-help", label: help ? "Hide keyboard help" : "Show keyboard help" });
  for (const room of rooms) {
    if (room.joined) commands.push({ id: `switch:${room.id}`, label: `Switch to #${room.name}`, roomId: room.id });
  }
  commands.push({ id: "search-room", label: "Search this room" });
  commands.push({ id: "search-all", label: "Search all joined rooms" });
  return commands;
}

export function nextScope(scope) {
  return scope === "all" ? "room" : "all";
}

/** Pick the message sources for a scope from the local cache. */
export function scopeSources({ rooms = [], current = null, scope = "room", cache = new Map() } = {}) {
  const messagesOf = (id) => {
    const value = cache instanceof Map ? cache.get(id) : cache?.[id];
    return Array.isArray(value) ? value : [];
  };
  if (scope !== "all") {
    return current ? [{ roomId: current.id, roomName: current.name, messages: messagesOf(current.id) }] : [];
  }
  return rooms
    .filter((room) => room.joined)
    .map((room) => ({ roomId: room.id, roomName: room.name, messages: messagesOf(room.id) }));
}

function stamp(message) {
  const value = message?.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function scoreOf(text, needle, index) {
  let score = 0;
  let from = 0;
  let hits = 0;
  while ((from = text.indexOf(needle, from)) !== -1) {
    hits += 1;
    from += needle.length;
  }
  score += hits * 10;
  if (index === 0) score += 5;
  else if (/[\s.,!?;:]/.test(text[index - 1])) score += 3;
  return score;
}

export function snippetOf(text, index, length, radius = 24) {
  const plain = String(text).replace(/\s+/g, " ").trim();
  const start = Math.max(0, index - radius);
  const end = Math.min(plain.length, index + length + radius);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
}

/** Search loaded messages. Recalled messages are never searchable. */
export function searchMessages(query, sources, { limit = SEARCH_LIMIT } = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return [];
  const results = [];
  for (const source of sources) {
    for (const message of source.messages ?? []) {
      if (!message || message.recalledAt) continue;
      const text = String(message.text ?? "").replace(/\s+/g, " ").trim();
      if (!text || text === "[recalled]") continue;
      const lower = text.toLowerCase();
      const index = lower.indexOf(needle);
      if (index < 0) continue;
      results.push({
        roomId: source.roomId,
        roomName: source.roomName,
        message,
        snippet: snippetOf(text, index, needle.length),
        score: scoreOf(lower, needle, index),
      });
    }
  }
  results.sort((a, b) => b.score - a.score || stamp(b.message) - stamp(a.message));
  return results.slice(0, limit);
}