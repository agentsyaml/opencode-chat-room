import { createRandomId } from "./state.js";

const mentionPattern = /<at>@([^<]+)<\/at>/g;

export function renderMarkdown(root, text, app) {
  const mentions = [];
  const nonce = createRandomId();
  const source = String(text).replace(mentionPattern, (_, name) => {
    const token = `CHATMENTION${nonce}${mentions.length}END`;
    mentions.push({ token, name, literal: `<at>@${name}</at>` });
    return token;
  });
  const parsed = window.marked.parse(source, { gfm: true, breaks: true, async: false });
  const fragment = window.DOMPurify.sanitize(parsed, { RETURN_DOM_FRAGMENT: true });
  replaceMentionTokens(fragment, mentions, app);
  fragment.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
  fragment.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.disabled = true; });
  fragment.querySelectorAll("pre").forEach((pre) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.dataset.copyCode = "";
    button.dataset.i18n = "copyCode";
    button.textContent = app.t("copyCode");
    pre.appendChild(button);
  });
  root.appendChild(fragment);
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

export function copyCodeFromButton(button, app) {
  const code = button.parentElement.querySelector("code")?.textContent || "";
  return navigator.clipboard?.writeText(code).then(
    () => app.flash(button, "copiedCode"),
    () => app.showSendError("copyCodeFailed"),
  ) ?? app.showSendError("copyCodeFailed");
}
