// Lazy Office preview bridge. The heavy renderer bundles live under /assets/office
// and are fetched the first time a matching resource is opened.
const MAX_OFFICE_BYTES = 20 * 1024 * 1024;
const FORMATS = {
  docx: { url: new URL("../office/docx.bundle.js", import.meta.url).href, label: "Word document" },
  xlsx: { url: new URL("../office/xlsx.bundle.js", import.meta.url).href, label: "Excel workbook" },
  pptx: { url: new URL("../office/pptx.bundle.js", import.meta.url).href, label: "PowerPoint presentation" },
};
const loaded = new Map();

export class OfficePreviewError extends Error {
  name = "OfficePreviewError";
}

function load(kind) {
  let pending = loaded.get(kind);
  if (!pending) {
    pending = import(FORMATS[kind].url);
    pending.catch(() => loaded.delete(kind));
    loaded.set(kind, pending);
  }
  return pending;
}

function ensureStyles() {
  if (document.getElementById("officePreviewStyles")) return;
  const style = document.createElement("style");
  style.id = "officePreviewStyles";
  style.textContent = `
    .office-preview { min-width: 0; }
    .office-preview .docx-wrapper { align-items: center; align-items: safe center; }
    .office-preview .office-xlsx-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
    .office-preview .office-xlsx-tab { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid var(--line, #dcded4); border-radius: 6px; background: var(--surface, #fff); color: var(--ink-2, #555); cursor: pointer; }
    .office-preview .office-xlsx-tab[aria-selected="true"] { background: var(--accent-soft, #e1eee6); color: var(--ink, #222); font-weight: 600; }
    .office-preview .office-xlsx-panel { overflow: auto; max-width: 100%; }
    .office-preview .office-xlsx-table { border-collapse: collapse; font-size: 12px; }
    .office-preview .office-xlsx-table td { border: 1px solid var(--line, #dcded4); padding: 3px 7px; vertical-align: top; white-space: pre-wrap; }
    .office-preview .office-xlsx-note { margin: 6px 0 0; font-size: 12px; color: var(--ink-3, #777); }
  `;
  document.head.append(style);
}

export async function renderOffice(kind, blob, container, options = {}) {
  const format = FORMATS[kind];
  if (!format) throw new OfficePreviewError(`Unsupported Office preview format: ${kind}`);
  if (!(blob instanceof Blob)) throw new OfficePreviewError("Office preview needs a file.");
  if (blob.size === 0) throw new OfficePreviewError(`The ${format.label.toLowerCase()} is empty.`);
  if (blob.size > MAX_OFFICE_BYTES) {
    throw new OfficePreviewError(`${format.label} is too large to preview (limit 20 MiB).`);
  }
  if (!container) throw new OfficePreviewError("Office preview needs a container.");
  ensureStyles();
  container.replaceChildren();
  container.classList.add("office-preview");
  container.setAttribute("aria-busy", "true");
  try {
    const bundle = await load(kind);
    await bundle.render(blob, container, options);
  } catch (error) {
    container.replaceChildren();
    if (error instanceof Error && error.name === "OfficePreviewError") throw error;
    throw new OfficePreviewError(
      `Could not preview this ${format.label}. The file may be damaged or use an unsupported feature.`,
      { cause: error },
    );
  } finally {
    container.removeAttribute("aria-busy");
  }
}