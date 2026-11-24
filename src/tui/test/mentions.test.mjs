import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeMentions, mentionRanges } from "../mentions.mjs";

const people = [{ name: "Bob" }];

test("canonical mentions convert prose but leave fenced and inline code alone", () => {
  assert.equal(canonicalizeMentions("@Bob hi", people), "<at>@Bob</at> hi");
  assert.equal(canonicalizeMentions("`@Bob` @Bob", people), "`@Bob` <at>@Bob</at>");
  assert.equal(
    canonicalizeMentions("```js\nconst x = '@Bob';\n```\n@Bob", people),
    "```js\nconst x = '@Bob';\n```\n<at>@Bob</at>",
  );
  assert.equal(
    canonicalizeMentions("````\n<at>@Bob</at>\n````", people),
    "````\n<at>@Bob</at>\n````",
  );
  assert.equal(canonicalizeMentions("```\n@Bob", people), "```\n@Bob");
  // Fences nested in list items are indented four spaces; the body must stay literal.
  assert.equal(
    canonicalizeMentions("- item\n\n    ~~~js\n    const s = '@Bob';\n    ~~~", people),
    "- item\n\n    ~~~js\n    const s = '@Bob';\n    ~~~",
  );
  assert.equal(
    canonicalizeMentions("    ```\n    const s = '@Bob';\n", people),
    "    ```\n    const s = '@Bob';\n",
  );
  assert.equal(canonicalizeMentions("    const s = '@Bob';", people), "    const s = '@Bob';");
  // A one-backtick span may contain a longer backtick run as literal text.
  assert.equal(canonicalizeMentions("`a``` @Bob`", people), "`a``` @Bob`");
  // CRLF pastes keep the fence open/close behavior of LF text.
  assert.equal(
    canonicalizeMentions("```\r\n@Bob\r\n```\r\n@Bob", people),
    "```\r\n@Bob\r\n```\r\n<at>@Bob</at>",
  );
});

test("mention ranges skip code spans and mark the inner raw tag", () => {
  assert.deepEqual(mentionRanges("`@Bob` @Bob <at>@Bob</at>", people), [
    { start: 7, end: 11 },
    { start: 16, end: 20 },
  ]);
});