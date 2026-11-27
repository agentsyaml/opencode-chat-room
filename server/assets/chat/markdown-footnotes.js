// Code masking keeps footnote syntax literal inside fences and inline spans.
function maskCode(value, nonce) {
  const blocks = [];
  const token = () => `CHATCODETOKEN${nonce}${blocks.length}END`;
  let masked = String(value).replace(/^(```|~~~)[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, (block) => {
    const key = token(); blocks.push(block); return key;
  });
  masked = masked.replace(/(`+)([^`\n]*?)\1/g, (span) => {
    const key = token(); blocks.push(span); return key;
  });
  return {
    masked,
    maskIndented: (text) => text.replace(/^(?: {4}|\t).*$/gm, (line) => {
      const key = token(); blocks.push(line); return key;
    }),
    restore: (text) => text.replace(new RegExp(`CHATCODETOKEN${nonce}(\\d+)END`, "g"), (_, index) => blocks[Number(index)]),
  };
}

export function prepareFootnotes(value, nonce) {
  const code = maskCode(value, nonce);
  const lines = code.masked.split("\n"), definitions = new Map(), kept = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(lines[index]);
    if (!match) { kept.push(lines[index]); continue; }
    let body = match[2].trim();
    while (index + 1 < lines.length && /^(?: {2,}|\t)/.test(lines[index + 1])) {
      index++;
      body += `\n${lines[index].replace(/^(?: {2,4}|\t)/, "")}`;
    }
    definitions.set(match[1], code.restore(body));
    kept.push("");
  }
  const references = new Map(), tokens = [], tokenLabels = [];
  let source = code.maskIndented(kept.join("\n")).replace(/\[\^([^\]\s]+)\]/g, (literal, label) => {
    if (!definitions.has(label)) return literal;
    if (!references.has(label)) references.set(label, references.size + 1);
    const token = `CHATFOOTNOTE${nonce}${tokens.length}END`;
    tokens.push(token); tokenLabels.push(label);
    return token;
  });
  source = code.restore(source);
  // Footnote anchors live in the same document as messages and the preview, so
  // each render needs its own prefix or id="fn-1" would collide across them.
  return { source, definitions, references, tokens, tokenLabels, refIds: new Map(), idPrefix: `fn-${nonce}` };
}

export function replaceFootnoteTokens(fragment, notes) {
  if (!notes.tokens.length) return;
  const labels = new Map(notes.tokens.map((token, index) => [token, notes.tokenLabels[index]]));
  const pattern = new RegExp(`(${notes.tokens.join("|")})`, "g");
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT), nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest("code, pre, a")) continue;
    const pieces = (node.nodeValue || "").split(pattern);
    if (pieces.length === 1) continue;
    const replacement = document.createDocumentFragment();
    for (const piece of pieces) {
      const label = labels.get(piece);
      if (!label) { replacement.append(document.createTextNode(piece)); continue; }
      const number = notes.references.get(label), ids = notes.refIds.get(label) || [];
      const id = ids.length ? `${notes.idPrefix}-ref-${number}-${ids.length}` : `${notes.idPrefix}-ref-${number}`;
      ids.push(id); notes.refIds.set(label, ids);
      const sup = document.createElement("sup"), link = document.createElement("a");
      sup.className = "footnote-ref";
      link.id = id; link.href = `#${notes.idPrefix}-${number}`; link.textContent = `[${number}]`;
      link.setAttribute("role", "doc-noteref");
      sup.append(link); replacement.append(sup);
    }
    node.replaceWith(replacement);
  }
}

export function appendFootnotes(fragment, notes) {
  if (!notes.references.size) return;
  const section = document.createElement("section"), list = document.createElement("ol");
  section.className = "footnotes"; section.setAttribute("role", "doc-endnotes");
  for (const [label, number] of notes.references) {
    const item = document.createElement("li"), body = document.createElement("span");
    item.id = `${notes.idPrefix}-${number}`; item.setAttribute("role", "doc-endnote");
    body.className = "footnote-body";
    const parsed = window.marked.parseInline(notes.definitions.get(label) || "", { gfm: true, breaks: true });
    body.innerHTML = window.DOMPurify.sanitize(parsed);
    item.append(body);
    for (const id of notes.refIds.get(label) || []) {
      const back = document.createElement("a");
      back.href = `#${id}`; back.className = "footnote-backref"; back.textContent = "↩";
      back.setAttribute("aria-label", "Back to reference");
      item.append(document.createTextNode(" "), back);
    }
    list.append(item);
  }
  section.append(list); fragment.append(section);
}

export function decorateLinks(fragment) {
  fragment.querySelectorAll("a").forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    let external = /^(?:mailto|tel):/i.test(href);
    if (!external && /^(?:https?:)?\/\//i.test(href)) {
      try { external = new URL(href, location.href).origin !== location.origin; } catch { external = false; }
    }
    if (external) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else {
      // A relative or same-origin API URL would lose the bearer token in a top-level
      // navigation; keep the reader in place instead of opening a 401 page.
      link.removeAttribute("target");
      link.addEventListener("click", (event) => event.preventDefault());
    }
  });
}