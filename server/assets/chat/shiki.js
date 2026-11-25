// Lazy Shiki highlighting. The bundle is fetched on the first fenced code block,
// so a conversation without code never downloads or parses it.

const LANGUAGE_ALIASES = new Map([
  ["ts", "typescript"], ["typescript", "typescript"],
  ["tsx", "tsx"],
  ["js", "javascript"], ["javascript", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"], ["node", "javascript"],
  ["jsx", "jsx"],
  ["json", "json"], ["jsonc", "json"],
  ["bash", "shellscript"], ["sh", "shellscript"], ["zsh", "shellscript"],
  ["shell", "shellscript"], ["shellscript", "shellscript"], ["console", "shellscript"],
  ["yml", "yaml"], ["yaml", "yaml"],
  ["md", "markdown"], ["markdown", "markdown"],
  ["py", "python"], ["python", "python"],
  ["rs", "rust"], ["rust", "rust"],
  ["go", "go"], ["golang", "go"],
  ["java", "java"],
  ["sql", "sql"],
  ["html", "html"], ["htm", "html"],
  ["xml", "xml"], ["svg", "xml"], ["xsl", "xml"],
  ["css", "css"],
]);

const pending = new Set();
let highlighterPromise;
let failed = false;
let warned = false;

function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn("Syntax highlighting unavailable; showing plain code.", error);
}

function getHighlighter() {
  if (failed) return null;
  highlighterPromise ??= import("/assets/shiki.bundle.js")
    .then((module) => module.createHighlighter())
    .catch((error) => {
      failed = true;
      warnOnce(error);
      return null;
    });
  return highlighterPromise;
}

function languageOf(code) {
  return (/language-(\S+)/.exec(code.className) || [])[1]?.toLowerCase() || "";
}

// Returns Shiki's HTML (it escapes the code text) or null for an unknown or failed language.
export async function highlightToHtml(code, lang) {
  const language = LANGUAGE_ALIASES.get(String(lang || "").toLowerCase());
  if (!language) return null;
  try {
    const highlighter = await getHighlighter();
    if (!highlighter) return null;
    return highlighter.codeToHtml(code, { lang: language, theme: "chatroom" });
  } catch (error) {
    warnOnce(error);
    return null;
  }
}

export function whenShikiIdle() {
  return Promise.allSettled([...pending]);
}

// Replaces the escaped text inside one code element, leaving the surrounding
// pre, toolbar, wrap state, and copy button alone.
export function enhanceCodeElement(code) {
  const task = embed(code).catch(() => {}).finally(() => pending.delete(task));
  pending.add(task);
  return task;
}

async function embed(code) {
  if (!LANGUAGE_ALIASES.has(languageOf(code))) return;
  const markup = await highlightToHtml(code.textContent || "", languageOf(code));
  if (!markup || !code.isConnected) return;
  const template = document.createElement("template");
  template.innerHTML = markup;
  const rendered = template.content.querySelector("code");
  if (!rendered) return;
  code.replaceChildren(...rendered.childNodes);
  code.classList.add("shiki");
}