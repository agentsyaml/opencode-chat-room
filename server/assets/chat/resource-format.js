// Shared classification for resources that open in the reading pane. The server
// sniffs text and PDF uploads as application/octet-stream, so the filename
// extension is a first-class signal alongside the MIME type.
export const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

const MIME_LANGUAGES = {
  "application/json": "json", "application/ld+json": "json",
  "application/xml": "xml", "text/xml": "xml",
  "application/javascript": "javascript", "application/x-javascript": "javascript",
  "application/typescript": "typescript",
  "application/x-yaml": "yaml", "application/yaml": "yaml",
  "application/toml": "ini",
  "text/html": "xml", "text/css": "css",
};

const EXTENSION_LANGUAGES = {
  txt: "", log: "", csv: "", tsv: "",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", conf: "ini", env: "ini", properties: "properties",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", bat: "dos", cmd: "dos",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", kts: "kotlin", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  cs: "csharp", php: "php", swift: "swift", sql: "sql",
  html: "xml", htm: "xml", css: "css", scss: "scss", less: "less",
  xml: "xml", svg: "xml", vue: "xml", svelte: "xml",
  lua: "lua", r: "r", pl: "perl", pm: "perl", dart: "dart",
  gradle: "groovy", dockerfile: "dockerfile", makefile: "makefile", mk: "makefile",
};

const LANGUAGE_NAMES = {
  typescript: "TypeScript", javascript: "JavaScript", python: "Python", ruby: "Ruby",
  bash: "Shell", yaml: "YAML", json: "JSON", xml: "XML", c: "C", cpp: "C++",
  csharp: "C#", kotlin: "Kotlin", rust: "Rust", go: "Go", java: "Java",
  php: "PHP", swift: "Swift", sql: "SQL", css: "CSS", scss: "SCSS", less: "Less",
  ini: "Config", properties: "Properties", powershell: "PowerShell", dos: "Batch",
  dockerfile: "Dockerfile", makefile: "Makefile", lua: "Lua", r: "R", perl: "Perl",
  dart: "Dart", groovy: "Gradle",
};

const TEXT_MIMES = new Set([
  "application/json", "application/ld+json", "application/xml", "application/x-yaml",
  "application/yaml", "application/toml", "application/javascript",
  "application/x-javascript", "application/typescript",
]);

function fileExtension(name) {
  const base = String(name || "").toLowerCase().split(/[\\/]/).pop() || "";
  if (base === "dockerfile" || base === "makefile") return base;
  return /\.([a-z0-9]+)$/.exec(base)?.[1] || "";
}

function isTextMime(mime) {
  if (mime === "text/markdown" || mime === "text/x-markdown") return false;
  return mime.startsWith("text/") || TEXT_MIMES.has(mime);
}

export function docPreviewFormat(resource) {
  const mime = String(resource?.mimeType || "").split(";")[0].trim().toLowerCase();
  const name = String(resource?.name || "");
  const ext = fileExtension(name);
  if (mime === "application/pdf" || ext === "pdf") return { kind: "pdf", language: "", label: "PDF" };
  if (mime === "text/markdown" || mime === "text/x-markdown" || ext === "md" || ext === "markdown") {
    return { kind: "markdown", language: "", label: "" };
  }
  const knownExtension = Object.hasOwn(EXTENSION_LANGUAGES, ext);
  if (!knownExtension && !isTextMime(mime)) return null;
  const language = knownExtension ? EXTENSION_LANGUAGES[ext] : MIME_LANGUAGES[mime] || "";
  return { kind: "text", language, label: LANGUAGE_NAMES[language] || (ext ? ext.toUpperCase() : "Text") };
}

export const isDocPreviewResource = (resource) => docPreviewFormat(resource) !== null;