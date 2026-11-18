import { createRandomId, LS } from "./state.js";
import { isRoomAdmin } from "./admin-badge.js";

const mentionPattern = /<at>@([^<]+)<\/at>/g;
const resourcePattern = /\[\[resource:([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\]\]/gi;
let mermaidReady = false;
const previewUrls = new Map();
let previewObserver;

export function renderMarkdown(root, text, app) {
  const mentions = [], diagrams = new Map();
  const nonce = createRandomId();
  const source = String(text).replace(mentionPattern, (_, name) => {
    const token = `CHATMENTION${nonce}${mentions.length}END`;
    mentions.push({ token, name, literal: `<at>@${name}</at>` });
    return token;
  });
  const renderer = new window.marked.Renderer(), renderCode = renderer.code.bind(renderer);
  renderer.code = (token) => {
    if ((token.lang || "").trim().toLowerCase().split(/\s+/)[0] !== "mermaid") return renderCode(token);
    const key = `CHATDIAGRAM${nonce}${diagrams.size}END`;
    const literalToken = new RegExp(`CHATMENTION${nonce}\\d+END`, "g");
    diagrams.set(key, token.text.replace(literalToken, (value) => mentions.find((mention) => mention.token === value)?.literal || value));
    return `<div data-chat-mermaid="${key}"></div>`;
  };
  const parsed = window.marked.parse(source, { gfm: true, breaks: true, async: false, renderer });
  const fragment = window.DOMPurify.sanitize(parsed, { RETURN_DOM_FRAGMENT: true });
  replaceMentionTokens(fragment, mentions, app);
  const resources = replaceResourceMarkers(fragment, app);
  const diagramNodes = [...fragment.querySelectorAll("[data-chat-mermaid]")];
  for (const node of diagramNodes) {
    const source = diagrams.get(node.dataset.chatMermaid);
    node.removeAttribute("data-chat-mermaid"); node.className = "mermaid-diagram";
    if (source !== undefined) showDiagramFallback(node, source, app, !isUnsafeDiagram(source));
  }
  fragment.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
  fragment.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.disabled = true; });
  root.appendChild(fragment);
  for (let i = 0; i < diagramNodes.length; i++) {
    const source = diagrams.get(`CHATDIAGRAM${nonce}${i}END`);
    if (!isUnsafeDiagram(source)) void renderDiagram(diagramNodes[i], source, app);
  }
  for (const resource of resources) void loadResourceCard(resource.card, resource.roomId, app);
}

async function initializeMermaid() {
  if (mermaidReady) return;
  if (!window.mermaid) await new Promise((resolve, reject) => {
    const script = document.querySelector('script[src$="mermaid-11.12.2.min.js"]');
    if (!script) return reject(new Error("Mermaid bundle is missing"));
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", reject, { once: true });
    window.addEventListener("load", resolve, { once: true });
  });
  if (!window.mermaid) throw new Error("Mermaid bundle failed to load");
  window.mermaid.initialize({
    startOnLoad: false, securityLevel: "strict", htmlLabels: false,
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
    flowchart: { htmlLabels: false }, maxTextSize: 20000, maxEdges: 200, suppressErrorRendering: true,
    secure: ["secure", "securityLevel", "startOnLoad", "htmlLabels", "flowchart", "theme", "themeCSS", "themeVariables", "dompurifyConfig", "maxTextSize", "maxEdges", "suppressErrorRendering"],
  });
  mermaidReady = true;
}
async function renderDiagram(node, source, app) {
  if (source === undefined || isUnsafeDiagram(source)) return;
  try {
    await initializeMermaid();
    const { svg } = await window.mermaid.render(`oc-chat-${createRandomId()}`, source);
    if (!node.isConnected) return;
    const fragment = window.DOMPurify.sanitize(svg, {
      RETURN_DOM_FRAGMENT: true, USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["foreignObject", "a", "script"], FORBID_ATTR: ["href", "xlink:href", "onclick", "onload"],
      ALLOW_DATA_ATTR: false,
    });
    if (!fragment.querySelector("svg")) throw new Error("Diagram SVG was rejected");
    const update = () => node.replaceChildren(fragment);
    if (app.preserveReadingLayout) await app.preserveReadingLayout(update); else update();
  } catch {
    if (node.isConnected) showDiagramFallback(node, source, app, false);
  }
}
function isUnsafeDiagram(source = "") {
  return /%%\s*\{|^\s*---\s*(?:\r?\n)|\burl\s*\(|@import|@\s*\{[^}]*\b(?:img|image)\s*:/i.test(source);
}
function showDiagramFallback(node, source, app, loading) {
  node.textContent = "";
  const status = document.createElement("p"); status.className = "diagram-status";
  status.setAttribute("role", "status"); status.textContent = app.t(loading ? "diagramLoading" : "diagramRenderFailed");
  node.append(status);
  if (!loading) {
    const pre = document.createElement("pre"), code = document.createElement("code");
    code.textContent = source; pre.append(code); node.append(pre);
  }
}

function replaceResourceMarkers(fragment, app) {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT), nodes = [], cards = [], roomId = app.state.room?.id;
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest("code, pre, a")) continue;
    const value = node.nodeValue || "", replacement = document.createDocumentFragment();
    let last = 0, match;
    resourcePattern.lastIndex = 0;
    while ((match = resourcePattern.exec(value))) {
      replacement.append(document.createTextNode(value.slice(last, match.index)));
      const card = document.createElement("span"), status = document.createElement("span");
      card.className = "chat-resource"; card.dataset.resourceId = match[1]; card.setAttribute("role", "group");
      status.className = "resource-status"; status.setAttribute("role", "status");
      status.textContent = app.t("resourceLoading"); card.append(status); replacement.append(card);
      cards.push({ card, roomId }); last = resourcePattern.lastIndex;
    }
    if (last) { replacement.append(document.createTextNode(value.slice(last))); node.replaceWith(replacement); }
  }
  return cards;
}
async function loadResourceCard(card, roomId, app) {
  try {
    const id = card.dataset.resourceId;
    const result = await app.api(`/rooms/${encodeURIComponent(roomId)}/resources/${encodeURIComponent(id)}`);
    if (!card.isConnected) return;
    const resource = result.resource, type = String(resource.mimeType).split(";")[0].toLowerCase();
    card.setAttribute("aria-label", resource.name);
    const info = document.createElement("span"), name = document.createElement("span"), size = document.createElement("span"), actions = document.createElement("span"), status = document.createElement("span");
    info.className = "resource-info"; name.className = "resource-name"; name.textContent = resource.name;
    size.className = "resource-size"; size.textContent = formatBytes(resource.size); info.append(name, size);
    actions.className = "resource-actions"; status.className = "resource-status"; status.setAttribute("role", "status");
    card.replaceChildren(info, actions, status);
    const download = resourceButton("resourceDownload", resource.name, () => downloadResource(card, roomId, id, resource, app, status, download), app);
    download.classList.add("resource-download");
    if (isRoomAdmin(app)) {
      let remove;
      remove = resourceMenuItem("resourceDelete", () => deleteResource(card, roomId, id, resource, app, status, remove), app);
      actions.append(resourceSplit(app, resource, download, remove));
    } else actions.append(download);
    if (previewKind(type)) {
      const preview = resourceButton("resourcePreview", resource.name, () => previewResource(card, roomId, id, resource, type, preview, app, status), app);
      actions.append(preview);
      // Media you sent yourself is shown inline; other people's media stays collapsed.
      if (card.closest(".msg.own")) void previewResource(card, roomId, id, resource, type, preview, app, status);
    }
  } catch (error) { if (card.isConnected) setResourceError(card, app, error?.status === 404 ? "resourceDeleted" : "resourceFailed"); }
}
function setResourceButton(button, key, name, app) {
  button.dataset.i18n = key; button.textContent = app.t(key);
  button.setAttribute("aria-label", `${app.t(key)}: ${name}`);
}
function resourceButton(key, name, action, app) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "btn ghost small resource-button";
  setResourceButton(button, key, name, app);
  button.addEventListener("click", action); return button;
}
function resourceMenuItem(key, action, app) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "menu-action danger-text"; button.setAttribute("role", "menuitem");
  button.dataset.i18n = key; button.textContent = app.t(key);
  button.addEventListener("click", action); return button;
}
function resourceSplit(app, resource, download, item) {
  const group = document.createElement("span"), toggle = document.createElement("button"), menu = document.createElement("span");
  group.className = "resource-split";
  toggle.type = "button"; toggle.className = "btn ghost small resource-button resource-split-toggle";
  toggle.setAttribute("aria-haspopup", "menu"); toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("data-i18n-aria-label", "resourceMoreActions");
  toggle._i18nValues = { name: resource.name };
  toggle.setAttribute("aria-label", app.t("resourceMoreActions", { name: resource.name }));
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  icon.setAttribute("aria-hidden", "true"); icon.setAttribute("viewBox", "0 0 24 24"); path.setAttribute("d", "M6 9l6 6 6-6"); icon.append(path); toggle.append(icon);
  menu.className = "resource-split-menu"; menu.hidden = true; menu.setAttribute("role", "menu"); menu.append(item);
  group.append(download, toggle, menu);
  function close(focusToggle = false) {
    if (menu.hidden) return;
    menu.hidden = true; toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside);
    if (focusToggle) toggle.focus();
  }
  function open() {
    if (!menu.hidden) return;
    menu.hidden = false; toggle.setAttribute("aria-expanded", "true");
    document.addEventListener("click", outside); item.focus();
  }
  function outside(event) { if (!group.isConnected || !group.contains(event.target)) close(); }
  item.addEventListener("click", () => close(), { capture: true });
  toggle.addEventListener("click", () => { if (menu.hidden) open(); else close(true); });
  toggle.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); }
  });
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')], index = items.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") { event.preventDefault(); (event.key === "Home" ? items[0] : items.at(-1))?.focus(); }
  });
  group.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); close(true); }
  });
  group.addEventListener("focusout", (event) => { if (!menu.hidden && !group.contains(event.relatedTarget)) close(); });
  return group;
}
async function deleteResource(card, roomId, id, resource, app, status, button) {
  if (!(await app.confirmAction(app.t("resourceDeleteConfirm", { name: resource.name })))) return;
  button.disabled = true;
  status.textContent = app.t("resourceDeleting");
  try {
    await app.api(`/rooms/${encodeURIComponent(roomId)}/resources/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "x-session-id": LS.sessionID }, body: "{}" });
    if (!card.isConnected) return;
    card._previewElement?.remove();
    if (card._resourceUrl) URL.revokeObjectURL(card._resourceUrl);
    previewUrls.delete(card); delete card._resourceUrl; delete card._previewElement;
    card.querySelector(".resource-actions")?.remove();
    status.textContent = app.t("resourceDeleted");
    // The same file can appear in quoted or repeated messages; mark those copies too.
    for (const other of document.querySelectorAll(".chat-resource")) {
      if (other === card || other.dataset.resourceId !== id) continue;
      other.querySelector(".resource-actions")?.remove();
      const otherStatus = other.querySelector(".resource-status");
      if (otherStatus) otherStatus.textContent = app.t("resourceDeleted");
    }
  } catch {
    if (card.isConnected) { status.textContent = app.t("resourceDeleteFailed"); button.disabled = false; }
  }
}
async function downloadResource(card, roomId, id, resource, app, status, button) {
  if (!card.isConnected || button.disabled) return;
  button.disabled = true;
  status.textContent = app.t("resourceLoading");
  try {
    const blob = await app.apiBlob(`/rooms/${encodeURIComponent(roomId)}/resources/${encodeURIComponent(id)}/content`);
    if (!card.isConnected) return;
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = String(resource.name).replace(/[\\/\u0000-\u001f\u007f]/g, "_") || "download";
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = "";
  } catch { if (card.isConnected) status.textContent = app.t("resourceFailed"); }
  finally { if (card.isConnected) button.disabled = false; }
}
async function previewResource(card, roomId, id, resource, type, button, app, status) {
  if (!card.isConnected || button.disabled) return;
  button.disabled = true;
  if (card._previewElement) {
    try {
      await app.preserveReadingLayout(() => {
        card._previewElement.remove();
        setResourceButton(button, "resourcePreview", resource.name, app); button.disabled = false;
      });
      URL.revokeObjectURL(card._resourceUrl); previewUrls.delete(card); delete card._resourceUrl; delete card._previewElement;
    } catch {
      if (!card.isConnected) return;
    } finally { if (card.isConnected) button.disabled = false; }
    return;
  }
  status.textContent = app.t("resourceLoading");
  let url, media;
  const fail = () => {
    media?.remove(); media = undefined;
    if (url) { URL.revokeObjectURL(url); url = undefined; }
    setResourceButton(button, "resourcePreview", resource.name, app); button.disabled = false;
    if (card.isConnected) status.textContent = app.t("resourceFailed");
  };
  try {
    const blob = await app.apiBlob(`/rooms/${encodeURIComponent(roomId)}/resources/${encodeURIComponent(id)}/content`);
    if (!card.isConnected) return;
    url = URL.createObjectURL(blob);
    const kind = previewKind(type);
    media = document.createElement(kind);
    const ready = waitForMediaSize(media, kind);
    if (kind === "img") media.alt = resource.name;
    else { media.controls = true; media.preload = "metadata"; }
    media.addEventListener("error", fail, { once: true });
    media.src = url;
    // Update the control inside the layout step: a stalled animation frame must not
    // leave the preview open with a disabled button.
    await app.preserveReadingLayout(async () => {
      status.textContent = ""; card.append(media);
      setResourceButton(button, "resourceHide", resource.name, app); button.disabled = false;
      await ready;
    });
    if (!card.isConnected) { fail(); return; }
    card._resourceUrl = url; card._previewElement = media; previewUrls.set(card, url); watchPreviewRemoval();
  } catch { fail(); }
  finally { if (card.isConnected) button.disabled = false; }
}
function waitForMediaSize(media, kind) {
  const event = kind === "img" ? "load" : "loadedmetadata";
  if (kind === "img" && media.complete && media.naturalWidth) return Promise.resolve();
  if (kind !== "img" && media.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    media.addEventListener(event, resolve, { once: true });
    media.addEventListener("error", reject, { once: true });
  });
}
function previewKind(type) {
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(type)) return "img";
  if (["audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4"].includes(type)) return "audio";
  if (["video/mp4", "video/webm", "video/ogg"].includes(type)) return "video";
  return "";
}
function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}
function setResourceError(card, app, key = "resourceFailed") {
  card.textContent = "";
  const status = document.createElement("span"); status.className = "resource-status";
  status.setAttribute("role", "status"); status.textContent = app.t(key); card.append(status);
}
function watchPreviewRemoval() {
  const list = document.querySelector("#msgList");
  if (previewObserver || !list) return;
  previewObserver = new MutationObserver((records) => {
    for (const node of records.flatMap((record) => [...record.removedNodes])) {
      if (!(node instanceof Element)) continue;
      for (const card of [node, ...node.querySelectorAll(".chat-resource")]) {
        const url = previewUrls.get(card);
        if (url && !card.isConnected) { URL.revokeObjectURL(url); previewUrls.delete(card); }
      }
    }
  });
  previewObserver.observe(list, { childList: true, subtree: true });
}

function replaceMentionTokens(fragment, mentions, app) {
  const names = new Map(mentions.map((item) => [item.token, item]));
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const pieces = (node.nodeValue || "").split(/(CHATMENTION[\da-f-]+\d+END)/g);
    if (pieces.length === 1) continue;
    const replacement = document.createDocumentFragment();
    for (const piece of pieces) {
      const mention = names.get(piece);
      if (!mention) { replacement.appendChild(document.createTextNode(piece)); continue; }
      if (node.parentElement?.closest("code, pre")) {
        replacement.appendChild(document.createTextNode(mention.literal));
        continue;
      }
      const chip = document.createElement("span");
      chip.className = "mention-chip";
      if (app.mentionNames().has(mention.name)) chip.classList.add("member");
      chip.textContent = `@${mention.name}`;
      replacement.appendChild(chip);
    }
    node.replaceWith(replacement);
  }
}

export async function copyTextToClipboard(text, mentionSource = false) {
  // The HTML marker lets a later paste rebuild mention chips; unmarked external text stays literal.
  const html = mentionSource ? `<div data-chatroom-mentions>${String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char])}</div>` : "";
  try {
    if (html && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Use the legacy clipboard command when permission is unavailable. */ }
  const field = document.createElement(html ? "div" : "textarea"), selection = getSelection(), active = document.activeElement;
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  if (html) { field.contentEditable = "true"; field.innerHTML = html; } else field.value = text;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(field);
  if (html && selection) { const range = document.createRange(); range.selectNodeContents(field); selection.removeAllRanges(); selection.addRange(range); }
  else if (!html) field.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { /* Clipboard access may be disabled. */ }
  field.remove();
  if (selection) { selection.removeAllRanges(); ranges.forEach((range) => selection.addRange(range)); }
  if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  return copied;
}
