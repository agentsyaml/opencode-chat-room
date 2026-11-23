import test from "node:test";
import assert from "node:assert/strict";
import { MarkdownRenderable, getTreeSitterClient } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  MENTION_SENTINEL,
  createMarkdownSyntax,
  createMentionRenderNode,
  formatAttachments,
  prepareMarkdown,
} from "../markdown.mjs";
import { themeFor } from "../ui-theme.mjs";

test("prepareMarkdown marks prose mentions and leaves code untouched", () => {
  const source = [
    "Hi <at>@bob</at> and <at>@carol</at>, @bare is plain.",
    "Spaced <at>@mary jane</at> stays one mention.",
    "Inline `<at>@inline</at>` keeps tags.",
    "```",
    "<at>@code</at>",
    "```",
  ].join("\n");
  const prepared = prepareMarkdown(source);
  assert.match(prepared, /Hi `\u200B@bob` and `\u200B@carol`, @bare is plain\./);
  assert.match(prepared, /Spaced `\u200B@mary jane` stays one mention\./);
  assert.match(prepared, /`<at>@inline<\/at>`/);
  assert.match(prepared, /```\n<at>@code<\/at>\n```/);
  assert.equal(prepared.includes(`${MENTION_SENTINEL}@bare`), false);
  assert.equal(
    prepareMarkdown("- item\n\n    ~~~js\n    <at>@code</at>\n    ~~~").includes(MENTION_SENTINEL),
    false,
  );
  assert.equal(prepareMarkdown("`a``` <at>@code</at>`").includes(MENTION_SENTINEL), false);
  assert.equal(prepareMarkdown("    <at>@code</at>").includes(MENTION_SENTINEL), false);
});

test("attachment markers render as a label instead of leaking the UUID", async () => {
  const first = "0eebea95-8672-4aa1-a77a-0e9b6e3f39e1";
  const second = "11111111-2222-4333-8444-555555555555";
  assert.equal(formatAttachments(`[[resource:${first}]]`), "Attachments");
  assert.equal(formatAttachments(`[[resource:${first}]] [[resource:${second}]]`), "Attachments");
  assert.equal(formatAttachments(`Release ready [[resource:${first}]]`), "Release ready · Attachments");
  assert.equal(formatAttachments("plain @bob"), "plain @bob");

  const context = await createTestRenderer({ width: 60, height: 8 });
  const theme = themeFor("dark");
  const markdown = new MarkdownRenderable(context.renderer, {
    id: "attachment-test",
    width: "100%",
    content: formatAttachments(`[[resource:${first}]]`),
    syntaxStyle: createMarkdownSyntax(theme),
    treeSitterClient: getTreeSitterClient(),
    fg: theme.text,
    conceal: true,
    concealCode: false,
  });
  context.renderer.root.add(markdown);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await context.renderOnce();
  }
  await context.flush();
  const frame = context.captureCharFrame();
  assert.match(frame, /Attachments/);
  assert.equal(frame.includes(first), false);
  context.renderer.destroy();
});

test("mentions inside headings and list items render without raw tags or sentinels", async () => {
  const context = await createTestRenderer({ width: 70, height: 16 });
  const theme = themeFor("dark");
  const markdown = new MarkdownRenderable(context.renderer, {
    id: "mention-test",
    width: "100%",
    content: prepareMarkdown("# hello <at>@bob</at>\n\n- ping <at>@carol</at>\n\n```\n<at>@code</at>\n```"),
    syntaxStyle: createMarkdownSyntax(theme),
    treeSitterClient: getTreeSitterClient(),
    fg: theme.text,
    conceal: true,
    concealCode: false,
    renderNode: createMentionRenderNode(context.renderer, theme, "mention-test"),
  });
  context.renderer.root.add(markdown);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await context.renderOnce();
  }
  await context.flush();
  const frame = context.captureCharFrame();
  const lines = frame.split("\n");
  assert.ok(lines.some((line) => /hello @bob/.test(line)), `heading mention missing:\n${frame}`);
  assert.ok(lines.some((line) => /ping @carol/.test(line)), `list mention missing:\n${frame}`);
  assert.ok(lines.some((line) => line.includes("<at>@code</at>")), `code fence changed:\n${frame}`);
  const prose = lines.filter((line) => !line.includes("<at>@code</at>"));
  assert.equal(prose.some((line) => line.includes("<at>") || line.includes("</at>")), false, frame);
  assert.equal(frame.includes(MENTION_SENTINEL), false, frame);
  context.renderer.destroy();
});