// Browser entry for server/assets/shiki.bundle.js. scripts/build-shiki.ts bundles
// this file with Bun; keeping the language list here means one source of truth.
import { createCssVariablesTheme, createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import typescript from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import javascript from "@shikijs/langs/javascript";
import jsx from "@shikijs/langs/jsx";
import json from "@shikijs/langs/json";
import html from "@shikijs/langs/html";
import css from "@shikijs/langs/css";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import go from "@shikijs/langs/go";
import rust from "@shikijs/langs/rust";
import java from "@shikijs/langs/java";
import sql from "@shikijs/langs/sql";
import yaml from "@shikijs/langs/yaml";
import shellscript from "@shikijs/langs/shellscript";
import xml from "@shikijs/langs/xml";

const languages = [
  ...typescript, ...tsx, ...javascript, ...jsx, ...json, ...html, ...css,
  ...markdown, ...python, ...go, ...rust, ...java, ...sql, ...yaml,
  ...shellscript, ...xml,
];

const theme = createCssVariablesTheme({ name: "chatroom", variablePrefix: "--shiki-", fontStyle: true });

// The chat client creates the highlighter lazily so a page without code never loads the bundle.
export function createHighlighter() {
  return createHighlighterCore({ themes: [theme], langs: languages, engine: createJavaScriptRegexEngine() });
}