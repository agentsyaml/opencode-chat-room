// Mention helpers shared by the composer suggestions and outgoing messages.
// Display names stay visible while typing; the wire format is applied on send.
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function mentionNames(participants = []) {
  const names = [];
  const seen = new Set(["all"]);
  for (const participant of Array.isArray(participants) ? participants : []) {
    const name = String(participant?.name ?? participant?.id ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

export function mentionItems(participants, query = "") {
  const needle = String(query ?? "").toLowerCase();
  const items = mentionNames(participants).map((name) => ({
    name,
    insert: `@${name}`,
    label: name,
  }));
  items.push({ name: "all", insert: "@all", label: "Everyone (@all)" });
  return items.filter((item) => {
    const haystack = `${item.label} ${item.name}`.toLowerCase();
    return !needle || haystack.includes(needle);
  });
}

/** Locate the @token at the end of the draft, outside email-like tokens. */
export function mentionTrigger(text) {
  const source = String(text ?? "");
  const match = source.match(/(^|[^\p{L}\p{N}_@])@([^\n@]{0,64})$/u);
  if (!match) return null;
  const query = match[2];
  return { start: source.length - query.length - 1, query, cursor: source.length };
}

export function insertMention(draft, trigger, insert) {
  const source = String(draft ?? "");
  const at = trigger ?? mentionTrigger(source);
  if (!at) return source;
  const before = source.slice(0, at.start);
  const after = source.slice(at.cursor ?? source.length);
  return `${before}${insert} ${after}`;
}

/** Find a closing backtick run of exactly `length`, never a longer run. */
function closingBackticks(source, from, end, length) {
  let i = from;
  while (i < end) {
    if (source[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 0;
    while (i + run < end && source[i + run] === "`") run += 1;
    if (run === length) return i;
    i += run;
  }
  return -1;
}

/** Split Markdown prose from fenced/indented code and inline code spans. */
function codeSegments(source) {
  const segments = [];
  let proseStart = 0;
  let lineStart = 0;
  const push = (start, end, code) => {
    if (end > start) segments.push({ text: source.slice(start, end), code, start, end });
  };
  while (lineStart < source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? source.length : lineEnd;
    const line = source.slice(lineStart, end);
    const opener = /^([ \t]*)(`{3,}|~{3,})/.exec(line);
    if (opener) {
      if (lineStart > proseStart) splitInlineCode(source, proseStart, lineStart, segments);
      const fence = opener[2];
      const indent = opener[1].length;
      let scan = lineEnd < 0 ? source.length : lineEnd + 1;
      let closed = source.length;
      while (scan < source.length) {
        const nextEnd = source.indexOf("\n", scan);
        const stop = nextEnd < 0 ? source.length : nextEnd;
        const close = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/.exec(source.slice(scan, stop));
        if (close && close[2][0] === fence[0] && close[2].length >= fence.length
          && close[1].length <= indent + 3) {
          closed = nextEnd < 0 ? source.length : nextEnd + 1;
          break;
        }
        scan = nextEnd < 0 ? source.length : nextEnd + 1;
      }
      push(lineStart, closed, true);
      proseStart = closed;
      lineStart = closed;
      continue;
    }
    // CommonMark indented code is also literal. Treat four spaces/tab as code
    // rather than risking a mention rewrite inside it.
    if (/^(?: {4,}|\t)/.test(line)) {
      if (lineStart > proseStart) splitInlineCode(source, proseStart, lineStart, segments);
      let scan = lineStart;
      let closed = source.length;
      while (scan < source.length) {
        const nextEnd = source.indexOf("\n", scan);
        const stop = nextEnd < 0 ? source.length : nextEnd;
        const current = source.slice(scan, stop);
        if (current.trim() && !/^(?: {4,}|\t)/.test(current)) {
          closed = scan;
          break;
        }
        scan = nextEnd < 0 ? source.length : nextEnd + 1;
      }
      push(lineStart, closed, true);
      proseStart = closed;
      lineStart = closed;
      continue;
    }
    lineStart = lineEnd < 0 ? source.length : lineEnd + 1;
  }
  splitInlineCode(source, proseStart, source.length, segments);
  return segments;
}

function splitInlineCode(source, start, end, segments) {
  let prose = start;
  let i = start;
  while (i < end) {
    if (source[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 1;
    while (i + run < end && source[i + run] === "`") run += 1;
    const close = closingBackticks(source, i + run, end, run);
    if (close < 0) {
      i += run;
      continue;
    }
    if (i > prose) segments.push({ text: source.slice(prose, i), code: false, start: prose, end: i });
    segments.push({ text: source.slice(i, close + run), code: true, start: i, end: close + run });
    prose = close + run;
    i = prose;
  }
  if (end > prose) segments.push({ text: source.slice(prose, end), code: false, start: prose, end });
}

function convertPlain(segment, names) {
  if (!segment) return segment;
  const candidates = ["all", ...names].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_.@])@(${candidates.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  return segment.replace(pattern, (_match, name) => `<at>@${name}</at>`);
}

function convertProse(source, names) {
  const tag = /<at>[\s\S]*?<\/at>/giu;
  let output = "";
  let last = 0;
  for (const match of source.matchAll(tag)) {
    output += convertPlain(source.slice(last, match.index), names);
    output += match[0];
    last = match.index + match[0].length;
  }
  return output + convertPlain(source.slice(last), names);
}

/** Convert known @names and @all to <at> tags, preserving code and existing tags. */
export function canonicalizeMentions(text, participants = []) {
  const source = String(text ?? "");
  const names = mentionNames(participants);
  return codeSegments(source)
    .map((segment) => (segment.code ? segment.text : convertProse(segment.text, names)))
    .join("");
}

/** Character ranges for visible mention chips, excluding email-like tokens. */
export function mentionRanges(text, participants = []) {
  const source = String(text ?? "");
  const ranges = [];
  const candidates = ["all", ...mentionNames(participants)].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_.@])@(${candidates.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  for (const segment of codeSegments(source)) {
    if (segment.code) continue;
    const tag = /<at>([\s\S]*?)<\/at>/giu;
    let last = 0;
    const plain = [];
    for (const match of segment.text.matchAll(tag)) {
      const inner = match[1];
      const trimmed = inner.trim();
      const at = trimmed.indexOf("@");
      if (at >= 0) {
        const innerStart = segment.start + match.index + 4 + (inner.length - inner.trimStart().length);
        ranges.push({ start: innerStart + at, end: innerStart + trimmed.length });
      }
      plain.push([last, match.index]);
      last = match.index + match[0].length;
    }
    plain.push([last, segment.text.length]);
    for (const [start, end] of plain) {
      const piece = segment.text.slice(start, end);
      for (const match of piece.matchAll(pattern)) {
        ranges.push({
          start: segment.start + start + match.index,
          end: segment.start + start + match.index + match[0].length,
        });
      }
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}