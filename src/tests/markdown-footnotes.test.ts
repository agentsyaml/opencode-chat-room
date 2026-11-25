import { expect, test } from "bun:test";
import { prepareFootnotes } from "../../server/assets/chat/markdown-footnotes.js";

test("indented code blocks keep footnote literals", () => {
  const source = [
    "Paragraph[^note].",
    "",
    "    [^x] indented",
    "    [^x]: definition line",
    "",
    "- list item",
    "",
    '      const nested = "[^x]";',
    "",
    "    ^ ordinary text",
    "",
    "[^note]: note body",
  ].join("\n");
  const notes = prepareFootnotes(source, "test");
  const lines = notes.source.split("\n");
  expect(notes.idPrefix).toBe("fn-test");
  expect(notes.references.has("x")).toBe(false);
  expect(lines.some((line: string) => line.includes("CHATFOOTNOTE") && /^\s{4,}/.test(line))).toBe(false);
  expect(notes.source).toContain("[^x] indented");
  expect(notes.source).toContain("[^x]: definition line");
  expect(notes.source).toContain('const nested = "[^x]";');
  expect(notes.source).toContain("^ ordinary text");
});