/// <reference lib="dom" />

import * as monaco from "monaco-editor/editor/editor.api";
import { jsonDefaults } from "monaco-editor/languages/features/json/register";
import "monaco-editor/languages/definitions/yaml/register";
import { isMap, isScalar, isSeq, parseDocument, stringify as stringifyYaml } from "yaml";
import {
  buildInboundSchema,
  buildRulesSchema,
  formatPath,
  validateAgainstSchema,
  type JsonSchema,
  type RuleAccount,
  type SchemaIssue,
} from "./integration-schema";

export type RulesKind = "rules" | "inbound";
export type RulesFormat = "json" | "yaml";
export type EditorError = { line: number; column: number; path: string; message: string };
export type EditorValidation = {
  kind: RulesKind;
  format: RulesFormat;
  text: string;
  value: unknown;
  valid: boolean;
  errors: EditorError[];
};
export type IntegrationRulesEditor = {
  getKind: () => RulesKind;
  getFormat: () => RulesFormat;
  setFormat: (format: RulesFormat) => void;
  setValue: (value: unknown) => void;
  setAccounts: (accounts: RuleAccount[]) => void;
  validate: () => EditorValidation;
  reveal: (line: number, column: number) => void;
  setReadOnly: (readOnly: boolean) => void;
  focus: () => void;
  dispose: () => void;
};
type Options = {
  kind: RulesKind;
  container: HTMLElement;
  value: unknown;
  format?: RulesFormat;
  accounts: RuleAccount[];
  onChange?: (validation: EditorValidation) => void;
};

type RegistryEntry = { kind: RulesKind; uri: string; schema: JsonSchema; modelUri: string };
const registry = new Map<RulesKind, RegistryEntry>();
let completionRegistered = false;
let themeObserver: MutationObserver | null = null;
let themeMedia: MediaQueryList | null = null;

const scope = globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker?: (workerId: string, label: string) => Worker } };
scope.MonacoEnvironment = {
  getWorker(_workerId, label) {
    return new Worker(`/assets/monaco/${label === "json" ? "json" : "editor"}.worker.js`);
  },
};

function isDarkTheme(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark") return true;
  return theme !== "light" && theme !== "forest" && theme !== "sand" && matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  monaco.editor.defineTheme("chatroom-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": read("--surface", "#fffefa"),
      "editorGutter.background": read("--surface", "#fffefa"),
      "editor.lineHighlightBackground": read("--surface-2", "#f2f0e8"),
      "editorLineNumber.foreground": read("--ink-3", "#63716b"),
    },
  });
  monaco.editor.defineTheme("chatroom-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: { "editor.background": read("--surface", "#182522") },
  });
  monaco.editor.setTheme(isDarkTheme() ? "chatroom-dark" : "chatroom-light");
}

function watchTheme() {
  applyTheme();
  if (themeObserver) return;
  themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  themeMedia = matchMedia("(prefers-color-scheme: dark)");
  themeMedia.addEventListener("change", applyTheme);
}

function publishJsonSchemas() {
  jsonDefaults.setDiagnosticsOptions({
    validate: false,
    allowComments: false,
    enableSchemaRequest: false,
    schemas: [...registry.values()].map((entry) => ({
      uri: entry.uri,
      fileMatch: [`*integration-${entry.kind}*`],
      schema: entry.schema,
    })),
  });
}

function schemaAtPath(root: JsonSchema, path: Array<string | number>, key?: string): JsonSchema | undefined {
  let schema: JsonSchema | undefined = root;
  for (const part of path) {
    if (!schema) return undefined;
    if (typeof part === "number") schema = schema.items;
    else schema = schema.properties?.[part];
  }
  return key ? schema?.properties?.[key] : schema;
}

function nodeAtPath(node: any, path: Array<string | number>): any {
  let current = node;
  for (const part of path) {
    if (!current) return current;
    if (typeof part === "number") {
      if (!isSeq(current)) return current;
      current = current.items[part];
    } else {
      if (!isMap(current)) return current;
      const pair = current.items.find((item: any) => isScalar(item.key) && item.key.value === part);
      if (!pair) return current;
      current = pair.value;
    }
  }
  return current;
}

function pathAtOffset(node: any, offset: number, path: Array<string | number> = []): Array<string | number> | null {
  const range = node?.range;
  if (!Array.isArray(range) || offset < range[0] || offset > range[2]) return null;
  if (isSeq(node)) {
    for (let index = 0; index < node.items.length; index++) {
      const found = pathAtOffset(node.items[index], offset, [...path, index]);
      if (found) return found;
    }
  } else if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
      const found = pathAtOffset(pair.value, offset, [...path, pair.key.value]);
      if (found) return found;
    }
  }
  return path;
}

function valueSuggestions(schema: JsonSchema, model: monaco.editor.ITextModel, position: monaco.Position) {
  const values = schema.const !== undefined ? [schema.const] : schema.enum;
  if (!values) return [];
  const word = model.getWordUntilPosition(position);
  const range = monaco.Range.fromPositions(
    new monaco.Position(position.lineNumber, word.startColumn),
    new monaco.Position(position.lineNumber, word.endColumn),
  );
  return values.map((value) => ({
    label: String(value),
    kind: monaco.languages.CompletionItemKind.Value,
    insertText: String(value),
    range,
    detail: schema.description,
  }));
}

function ensureYamlCompletion() {
  if (completionRegistered) return;
  completionRegistered = true;
  monaco.languages.registerCompletionItemProvider("yaml", {
    triggerCharacters: [":", " ", "-"],
    provideCompletionItems(model, position) {
      const entry = [...registry.values()].find((item) => item.modelUri === model.uri.toString());
      if (!entry) return { suggestions: [] };
      let doc: any;
      try { doc = parseDocument(model.getValue()); } catch { return { suggestions: [] }; }
      const root = doc.contents;
      const offset = model.getOffsetAt(position);
      const path = pathAtOffset(root, offset) ?? [];
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const match = /^\s*(?:-\s*)?["']?([A-Za-z0-9_.-]+)["']?\s*:\s*(.*)$/.exec(line);
      if (match) {
        const key = match[1]!;
        const container = path[path.length - 1] === key ? path.slice(0, -1) : path;
        const schema = schemaAtPath(entry.schema, container, key);
        return { suggestions: schema ? valueSuggestions(schema, model, position) : [] };
      }
      const schema = schemaAtPath(entry.schema, path);
      const properties = schema?.properties;
      if (!properties) return { suggestions: [] };
      const existing = new Set<string>();
      const container = nodeAtPath(root, path);
      if (isMap(container)) {
        for (const pair of container.items) if (isScalar(pair.key) && typeof pair.key.value === "string") existing.add(pair.key.value);
      }
      const word = model.getWordUntilPosition(position);
      const range = monaco.Range.fromPositions(
        new monaco.Position(position.lineNumber, word.startColumn),
        new monaco.Position(position.lineNumber, word.endColumn),
      );
      return {
        suggestions: Object.entries(properties)
          .filter(([key]) => !existing.has(key))
          .map(([key, child]) => ({
            label: key,
            kind: monaco.languages.CompletionItemKind.Property,
            insertText: `${key}: `,
            range,
            detail: child.type,
            documentation: child.description,
          })),
      };
    },
  });
}

type ParseResult = {
  value?: unknown;
  doc?: any;
  failure?: { line: number; column: number; message: string };
};

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
  return starts;
}

function positionAt(starts: number[], offset: number): { line: number; column: number } {
  let low = 0, high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
}

function cleanSyntaxMessage(message: string): string {
  return message
    .replace(/ in JSON at position \d+.*$/i, "")
    .replace(/\s*\(line \d+ column \d+\)$/i, "")
    .replace(/\s+at line \d+, column \d+.*$/i, "")
    .trim();
}

function parseJson(text: string): ParseResult {
  if (!text.trim()) return { failure: { line: 1, column: 1, message: "Rules cannot be empty." } };
  try {
    const value = JSON.parse(text);
    let doc;
    try { doc = parseDocument(text); } catch { doc = undefined; }
    return { value, doc };
  } catch (error) {
    const message = String((error as Error).message || error);
    const starts = lineStarts(text);
    const offset = Number(/position (\d+)/.exec(message)?.[1] ?? 0);
    const position = positionAt(starts, offset);
    return { failure: { ...position, message: cleanSyntaxMessage(message) || "Invalid JSON." } };
  }
}

function parseYaml(text: string): ParseResult {
  if (!text.trim()) return { failure: { line: 1, column: 1, message: "Rules cannot be empty." } };
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length) {
    const error = doc.errors[0]!;
    const starts = lineStarts(text);
    const offset = Number(error.pos?.[0] ?? 0);
    const fallback = positionAt(starts, offset);
    const line = error.linePos?.[0]?.line ?? fallback.line;
    const column = error.linePos?.[0]?.col ?? fallback.column;
    return { failure: { line, column, message: cleanSyntaxMessage(error.message) || "Invalid YAML." } };
  }
  try {
    return { value: doc.toJS(), doc };
  } catch (error) {
    return { failure: { line: 1, column: 1, message: String((error as Error).message || error) } };
  }
}

function issuePosition(issue: SchemaIssue, doc: any, text: string, kind: RulesKind): EditorError {
  const path = formatPath(kind === "inbound" ? "inbound" : "rules", issue.path);
  if (doc) {
    const node = nodeAtPath(doc.contents, issue.path);
    const range = node?.range;
    if (Array.isArray(range)) {
      const starts = lineStarts(text);
      const start = positionAt(starts, range[0]);
      return { ...start, path, message: issue.message };
    }
  }
  return { line: 1, column: 1, path, message: issue.message };
}

function stringifyValue(value: unknown, format: RulesFormat): string {
  if (format === "yaml") return stringifyYaml(value, { indent: 2, lineWidth: 0 });
  return JSON.stringify(value, null, 2);
}

function formatLabel(format: RulesFormat): string {
  return format === "yaml" ? "YAML" : "JSON";
}

export function createIntegrationRulesEditor(options: Options): IntegrationRulesEditor {
  const kind = options.kind;
  let format: RulesFormat = options.format ?? "json";
  let accounts = options.accounts;
  let schema = kind === "inbound" ? buildInboundSchema(accounts) : buildRulesSchema(accounts);
  const entry: RegistryEntry = {
    kind,
    uri: `inmemory://chat/integration-${kind}.schema.json`,
    schema,
    modelUri: `inmemory://chat/integration-${kind}.json`,
  };
  registry.set(kind, entry);
  publishJsonSchemas();
  ensureYamlCompletion();
  watchTheme();

  const text = stringifyValue(options.value ?? [], format);
  const model = monaco.editor.createModel(text, formatLabel(format).toLowerCase(), monaco.Uri.parse(entry.modelUri));
  const editor = monaco.editor.create(options.container, {
    model,
    theme: isDarkTheme() ? "chatroom-dark" : "chatroom-light",
    automaticLayout: true,
    ariaLabel: kind === "inbound" ? "Inbound routes" : "Integration rules",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    lineNumbersMinChars: 3,
    tabSize: 2,
    insertSpaces: true,
    autoIndent: "none",
    autoClosingBrackets: "never",
    autoClosingQuotes: "never",
    wordWrap: "on",
    fixedOverflowWidgets: true,
    renderLineHighlight: "line",
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    padding: { top: 8, bottom: 8 },
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    suggest: { showWords: false },
  });

  const validate = (): EditorValidation => {
    const current = model.getValue();
    const parsed = format === "yaml" ? parseYaml(current) : parseJson(current);
    const errors: EditorError[] = [];
    if (parsed.failure) {
      errors.push({ line: parsed.failure.line, column: parsed.failure.column, path: "", message: parsed.failure.message });
    } else {
      for (const issue of validateAgainstSchema(parsed.value, schema)) {
        errors.push(issuePosition(issue, parsed.doc, current, kind));
      }
    }
    errors.sort((left, right) => left.line - right.line || left.column - right.column);
    monaco.editor.setModelMarkers(model, "integration-rules", errors.map((error) => {
      const lineLength = model.getLineMaxColumn(Math.min(error.line, model.getLineCount()));
      return {
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: error.line,
        startColumn: error.column,
        endLineNumber: error.line,
        endColumn: Math.max(error.column + 1, Math.min(lineLength, error.column + 80)),
      };
    }));
    return { kind, format, text: current, value: parsed.value, valid: errors.length === 0, errors };
  };

  const emit = () => {
    const validation = validate();
    options.onChange?.(validation);
    return validation;
  };

  const setValue = (value: unknown) => {
    const next = stringifyValue(value ?? [], format);
    if (next === model.getValue()) emit();
    else model.setValue(next);
  };

  const setFormat = (next: RulesFormat) => {
    if (next === format) return;
    const parsed = format === "yaml" ? parseYaml(model.getValue()) : parseJson(model.getValue());
    format = next;
    monaco.editor.setModelLanguage(model, formatLabel(format).toLowerCase());
    if (!parsed.failure) {
      const nextText = stringifyValue(parsed.value, format);
      if (nextText !== model.getValue()) model.setValue(nextText);
      else emit();
    } else {
      emit();
    }
  };

  const setAccounts = (next: RuleAccount[]) => {
    accounts = next;
    schema = kind === "inbound" ? buildInboundSchema(accounts) : buildRulesSchema(accounts);
    entry.schema = schema;
    publishJsonSchemas();
    emit();
  };

  const change = model.onDidChangeContent(() => { emit(); });
  return {
    getKind: () => kind,
    getFormat: () => format,
    setFormat,
    setValue,
    setAccounts,
    validate,
    reveal: (line, column) => {
      const position = { lineNumber: Math.max(1, line), column: Math.max(1, column) };
      editor.revealPositionInCenter(position);
      editor.setPosition(position);
      editor.focus();
    },
    setReadOnly: (readOnly) => editor.updateOptions({ readOnly }),
    focus: () => editor.focus(),
    dispose: () => {
      change.dispose();
      editor.dispose();
      model.dispose();
      registry.delete(kind);
      publishJsonSchemas();
    },
  };
}