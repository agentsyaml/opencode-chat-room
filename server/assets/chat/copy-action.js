// Copy buttons for resource cards, the file list, and the preview header.
import { copyTextToClipboard } from "./clipboard.js";
import { iconNode } from "./icons.js";

export function createCopyButton(app, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `copy-action ${className}`.trim();
  button.dataset.i18nAriaLabel = "copyMessage";
  button.dataset.i18nTitle = "copyMessage";
  button.setAttribute("aria-label", app.t("copyMessage"));
  button.title = app.t("copyMessage");
  const feedback = document.createElement("span");
  feedback.className = "copy-feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  button.append(iconNode("copy", "copy-action-icon copy-icon"), iconNode("checkmark", "copy-action-icon copy-check"), feedback);
  return button;
}

export function setCopyFeedback(button, app, copied) {
  clearTimeout(button._copyFeedbackTimer);
  button.classList.toggle("is-copied", copied);
  button.classList.toggle("is-copy-failed", !copied);
  const key = copied ? "copied" : "copyMessageFailed";
  const feedback = button.querySelector(".copy-feedback");
  if (feedback) feedback.textContent = app.t(key);
  button.setAttribute("aria-label", app.t(key));
  button.title = app.t(key);
  button._copyFeedbackTimer = setTimeout(() => {
    button.classList.remove("is-copied", "is-copy-failed");
    button.setAttribute("aria-label", app.t("copyMessage"));
    button.title = app.t("copyMessage");
    if (feedback) feedback.textContent = "";
  }, 1600);
}

export async function copyResourceText(button, app, readText) {
  let copied = false;
  try {
    const text = await readText();
    copied = typeof text === "string" && text.length > 0 && await copyTextToClipboard(text);
  } catch {
    copied = false;
  }
  setCopyFeedback(button, app, copied);
  return copied;
}