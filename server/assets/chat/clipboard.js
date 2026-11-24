// Clipboard writes with a legacy fallback for browsers or permissions that block
// the async Clipboard API. Mention copy keeps its marker HTML for later pastes.
export async function copyTextToClipboard(text, mentionSource = false) {
  // The HTML marker lets a later paste rebuild mention chips; unmarked external text stays literal.
  const html = mentionSource ? `<div data-chatroom-mentions>${String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char])}</div>` : "";
  try {
    if (html && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Use the legacy clipboard command when permission is unavailable. */ }
  const field = document.createElement(html ? "div" : "textarea"), selection = getSelection(), active = document.activeElement;
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  if (html) { field.contentEditable = "true"; field.innerHTML = html; } else field.value = text;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(field);
  if (html && selection) { const range = document.createRange(); range.selectNodeContents(field); selection.removeAllRanges(); selection.addRange(range); }
  else if (!html) field.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { /* Clipboard access may be disabled. */ }
  field.remove();
  if (selection) { selection.removeAllRanges(); ranges.forEach((range) => selection.addRange(range)); }
  if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  return copied;
}