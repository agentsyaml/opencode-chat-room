/// <reference lib="dom" />
// Renderers bundled by scripts/build-office.ts. Each public function is imported by
// its own entry file, so a preview downloads only the library it needs.
import type { CellObject, WorkSheet } from "xlsx";

// A single sheet can claim the full Excel grid; keep the DOM bounded.
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLUMNS = 100;

type Sanitizer = {
  sanitize: (dirty: string | Node, config?: Record<string, unknown>) => string | Node;
};

export class OfficePreviewError extends Error {
  override name = "OfficePreviewError";
}

function requireSanitizer(): Sanitizer {
  const purify = (globalThis as { DOMPurify?: Sanitizer }).DOMPurify;
  if (!purify || typeof purify.sanitize !== "function") {
    throw new OfficePreviewError("This document needs the page sanitizer to render safely.");
  }
  return purify;
}

const SAFE_CSS_URL = /^(?:data:image\/|data:font\/|blob:|#)/i;

// docx-preview emits generated CSS. Drop imports and any URL that is not embedded
// data or a blob, while keeping the layout and colour declarations untouched.
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*(?:;|$)/gi, "")
    .replace(/url\(\s*(?:(["'])([\s\S]*?)\1|([^)]*))\s*\)/gi, (_match, _quote: string, quoted: string, bare: string) => {
      const value = String(quoted ?? bare ?? "").trim();
      return SAFE_CSS_URL.test(value) && !value.includes("\\") ? `url("${value.replaceAll('"', '\\"')}")` : "none";
    });
}

// docx-preview renders its own nodes. Style nodes are generated CSS and must stay,
// while every content node is passed through the page's DOMPurify.
export async function renderDocx(blob: Blob, container: HTMLElement): Promise<void> {
  const purify = requireSanitizer();
  const { parseAsync, renderDocument } = await import("docx-preview");
  const options = { useBase64URL: true, ignoreLastRenderedPageBreak: true, renderAltChunks: false };
  const parsed = await parseAsync(blob, options);
  const nodes = await renderDocument(parsed, options);
  container.replaceChildren();
  for (const node of nodes) {
    if (node.nodeName === "STYLE") {
      (node as HTMLStyleElement).textContent = sanitizeCss(node.textContent || "");
      container.append(node);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      container.append(node);
      continue;
    }
    const template = window.document.createElement("template");
    template.innerHTML = String(purify.sanitize((node as Element).outerHTML));
    container.append(template.content);
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function renderSheet(XLSX: typeof import("xlsx"), sheet: WorkSheet): HTMLElement {
  const wrapper = element("div", "office-xlsx-sheet");
  const ref = sheet["!ref"];
  const range = ref ? XLSX.utils.decode_range(ref) : null;
  if (!range) {
    wrapper.textContent = "This sheet is empty.";
    return wrapper;
  }
  const startRow = range.s.r, startColumn = range.s.c;
  const endRow = Math.min(range.e.r, startRow + MAX_SHEET_ROWS - 1);
  const endColumn = Math.min(range.e.c, startColumn + MAX_SHEET_COLUMNS - 1);
  const spans = new Map<string, { rowSpan: number; colSpan: number }>();
  const covered = new Set<string>();
  for (const merge of sheet["!merges"] || []) {
    const rowStart = Math.max(merge.s.r, startRow), rowEnd = Math.min(merge.e.r, endRow);
    const columnStart = Math.max(merge.s.c, startColumn), columnEnd = Math.min(merge.e.c, endColumn);
    if (rowEnd < rowStart || columnEnd < columnStart) continue;
    spans.set(`${rowStart}:${columnStart}`, { rowSpan: rowEnd - rowStart + 1, colSpan: columnEnd - columnStart + 1 });
    for (let row = rowStart; row <= rowEnd; row++) {
      for (let column = columnStart; column <= columnEnd; column++) {
        if (row !== rowStart || column !== columnStart) covered.add(`${row}:${column}`);
      }
    }
  }
  const table = element("table", "office-xlsx-table");
  const body = document.createElement("tbody");
  for (let row = startRow; row <= endRow; row++) {
    const tr = document.createElement("tr");
    for (let column = startColumn; column <= endColumn; column++) {
      const key = `${row}:${column}`;
      if (covered.has(key)) continue;
      const cell = element("td", "");
      const span = spans.get(key);
      if (span) {
        if (span.rowSpan > 1) cell.rowSpan = span.rowSpan;
        if (span.colSpan > 1) cell.colSpan = span.colSpan;
      }
      const source = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as CellObject | undefined;
      // textContent keeps cell text inert; cell.h (rich HTML) is never used.
      const text = source ? XLSX.utils.format_cell(source) : "";
      if (text) cell.textContent = text;
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(body);
  wrapper.append(table);
  if (range.e.r > endRow || range.e.c > endColumn) {
    const note = element("p", "office-xlsx-note");
    note.textContent = `Showing the first ${endRow - startRow + 1} rows and ${endColumn - startColumn + 1} columns.`;
    wrapper.append(note);
  }
  return wrapper;
}

export async function renderXlsx(blob: Blob, container: HTMLElement): Promise<void> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(new Uint8Array(await blob.arrayBuffer()), {
    type: "array", cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false, bookVBA: false, bookFiles: false,
  });
  const names = book.SheetNames.filter((name) => Boolean(book.Sheets[name]));
  if (!names.length) throw new Error("The workbook has no readable sheets.");
  const root = element("div", "office-xlsx");
  const tabs = element("div", "office-xlsx-tabs");
  tabs.setAttribute("role", "tablist");
  const panel = element("div", "office-xlsx-panel");
  const buttons: HTMLButtonElement[] = [];
  const show = (index: number) => {
    const sheet = book.Sheets[names[index] as string];
    if (!sheet) return;
    panel.replaceChildren(renderSheet(XLSX, sheet));
    buttons.forEach((button, position) => {
      const active = position === index;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
  };
  names.forEach((name, index) => {
    const button = element("button", "office-xlsx-tab");
    button.type = "button";
    button.textContent = name;
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => show(index));
    buttons.push(button);
    tabs.append(button);
  });
  tabs.hidden = names.length < 2;
  root.append(tabs, panel);
  container.replaceChildren(root);
  show(0);
}

const FORBIDDEN_TAGS = ["script", "iframe", "object", "embed", "form", "input", "button", "link", "meta", "base", "frame", "frameset", "applet"];
const SAFE_URI = /^(?:(?:https?|mailto):|#|data:|blob:)/i;
const SAFE_RESOURCE = /^(?:data:|blob:)/i;

// pptx-preview builds live DOM and may chart into canvases, so sanitize in place:
// string round-trips would erase canvas pixels and drop library event listeners.
export function sanitizeRendered(root: HTMLElement): void {
  const purify = requireSanitizer();
  // Moving a canvas keeps its bitmap, while DOMPurify drops its width/height
  // attributes (resizing and clearing it). Set canvases aside during the pass.
  const canvases = Array.from(root.querySelectorAll("canvas")).map((canvas) => {
    const parent = canvas.parentNode;
    const next = canvas.nextSibling;
    canvas.remove();
    return { canvas, parent, next };
  });
  purify.sanitize(root, {
    IN_PLACE: true,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ["srcset", "background", "srcdoc", "action", "formaction"],
    ALLOWED_URI_REGEXP: SAFE_URI,
  });
  for (const { canvas, parent, next } of canvases) {
    if (!parent || !root.contains(parent)) continue;
    parent.insertBefore(canvas, next && next.parentNode === parent ? next : null);
  }
  for (const node of [root as Element, ...Array.from(root.querySelectorAll("*"))]) {
    const tag = node.tagName.toLowerCase();
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) node.removeAttribute(attribute.name);
      else if (name === "style") node.setAttribute("style", sanitizeCss(attribute.value));
      else if (name === "href" || name === "xlink:href") {
        const allowed = tag === "a" ? /^(?:https?:|mailto:|#)/i : /^(?:#|data:|blob:)/i;
        if (!allowed.test(value)) node.removeAttribute(attribute.name);
      } else if ((name === "src" || name === "poster") && !SAFE_RESOURCE.test(value)) {
        node.removeAttribute(attribute.name);
      }
    }
  }
  for (const style of Array.from(root.querySelectorAll("style"))) style.textContent = sanitizeCss(style.textContent || "");
}

export async function renderPptx(blob: Blob, container: HTMLElement, options: { width?: number } = {}): Promise<void> {
  requireSanitizer();
  const { init } = await import("pptx-preview");
  const width = Math.max(320, Math.round(options.width || container.clientWidth || 960));
  // No fixed height: list mode stacks every slide and lets the preview pane scroll.
  const viewer = init(container, { width, mode: "list" });
  container.replaceChildren(viewer.wrapper);
  try {
    await viewer.preview(await blob.arrayBuffer());
    sanitizeRendered(viewer.wrapper);
  } catch (error) {
    viewer.destroy();
    container.replaceChildren();
    throw error;
  }
}