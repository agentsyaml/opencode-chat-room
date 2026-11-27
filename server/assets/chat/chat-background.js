// Personalized chat backgrounds are browser-local: no room or server state.
const GLOBAL_KEY = "chat.background";
const ROOM_PREFIX = "chat.background.room.";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64;
const DEFAULT_OPACITY = 35;

const clampOpacity = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : DEFAULT_OPACITY;
};

const normalize = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const opacity = clampOpacity(value.opacity);
  if (value.kind === "image" && typeof value.image === "string" && value.image.startsWith("data:image/") && value.image.length <= MAX_DATA_URL_LENGTH) {
    const name = typeof value.name === "string" ? value.name.slice(0, 120) : "";
    return { kind: "image", image: value.image, name, opacity };
  }
  return null;
};

const readStored = () => {
  try { return normalize(JSON.parse(localStorage.getItem(GLOBAL_KEY) || "null")); } catch { return null; }
};
const writeStored = (value) => {
  try {
    if (value) localStorage.setItem(GLOBAL_KEY, JSON.stringify(value));
    else localStorage.removeItem(GLOBAL_KEY);
    return true;
  } catch { return false; }
};
const clearStored = () => {
  try {
    localStorage.removeItem(GLOBAL_KEY);
    const roomKeys = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(ROOM_PREFIX)) roomKeys.push(key);
    }
    for (const key of roomKeys) localStorage.removeItem(key);
  } catch { /* Storage may be blocked; nothing to clear. */ }
};

const readImage = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("image"));
  reader.onerror = () => reject(reader.error || new Error("image"));
  reader.readAsDataURL(file);
});

export function initChatBackground(app) {
  const $ = app.$;
  const dialog = $("#chatSettings");
  const mode = $("#inChatBackgroundMode"), imageInput = $("#inChatBackgroundImage");
  const opacity = $("#inChatBackgroundOpacity"), opacityValue = $("#chatBackgroundOpacityValue");
  const imageField = $("#chatBackgroundImageField");
  const opacityField = $("#chatBackgroundOpacityField");
  const preview = $("#chatBackgroundPreview"), fileName = $("#chatBackgroundFileName");
  const status = $("#chatBackgroundStatus");
  if (!dialog || !mode || !imageInput || !opacity || !imageField || !opacityField || !preview || !status) return;

  let previewURL = null;
  const clearPreview = () => {
    if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
    preview.hidden = true;
    preview.removeAttribute("src");
    if (fileName) { fileName.hidden = true; fileName.textContent = ""; }
  };
  const setPreview = (src, name) => {
    if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = null; }
    preview.src = src;
    preview.hidden = false;
    if (fileName) {
      fileName.textContent = name || "";
      fileName.hidden = !name;
    }
  };

  const setStatus = (key, values, error = false) => {
    status.classList.toggle("is-error", error);
    if (!key) { status.hidden = true; status.textContent = ""; return; }
    app.setText(status, key, values);
    status.hidden = false;
  };

  const syncPreview = (value) => {
    if (value?.kind === "image" && typeof value.image === "string") setPreview(value.image, value.name);
    else clearPreview();
  };

  const syncControls = (value) => {
    mode.value = value?.kind === "image" ? "image" : "default";
    opacity.value = String(value?.opacity ?? DEFAULT_OPACITY);
    opacityValue.textContent = `${opacity.value}%`;
    opacityField.hidden = mode.value !== "image";
    imageField.hidden = mode.value !== "image";
    syncPreview(value);
  };

  const apply = () => {
    const value = readStored();
    const root = document.documentElement;
    root.classList.toggle("has-chat-background", Boolean(value));
    root.dataset.chatBackground = value?.kind || "default";
    if (!value) {
      root.style.removeProperty("--chat-background-image");
      root.style.removeProperty("--chat-background-opacity");
      return;
    }
    root.style.setProperty("--chat-background-image", `url("${value.image}")`);
    root.style.setProperty("--chat-background-opacity", String(value.opacity / 100));
  };

  const persist = (value) => {
    if (!writeStored(value)) return false;
    apply();
    return true;
  };

  const onModeChange = () => {
    setStatus("");
    const stored = readStored();
    if (mode.value === "default") {
      clearStored();
      imageInput.value = "";
      clearPreview();
      apply();
      syncControls({ kind: "default", opacity: stored?.opacity ?? clampOpacity(opacity.value) });
      return;
    }
    imageField.hidden = false;
    syncControls(stored || { kind: "image", opacity: clampOpacity(opacity.value) });
  };

  const onImageChange = async () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    const name = file.name || "image";
    setStatus("chatBackgroundApplying", { name });
    const objectURL = URL.createObjectURL(file);
    setPreview(objectURL, name);
    previewURL = objectURL;
    if (!file.type.startsWith("image/")) { setStatus("chatBackgroundInvalidType", undefined, true); return; }
    if (file.size > MAX_IMAGE_BYTES) { setStatus("chatBackgroundTooLarge", undefined, true); return; }
    try {
      const image = await readImage(file);
      if (!persist({ kind: "image", image, name, opacity: clampOpacity(opacity.value) })) {
        setStatus("chatBackgroundSaveFailed", undefined, true);
        return;
      }
      syncControls(readStored());
      setStatus("chatBackgroundApplied", { name });
    } catch {
      setStatus("chatBackgroundImageFailed", undefined, true);
    }
  };

  mode.addEventListener("change", onModeChange);
  opacity.addEventListener("input", () => {
    opacityValue.textContent = `${opacity.value}%`;
    const stored = readStored();
    if (stored) persist({ ...stored, opacity: clampOpacity(opacity.value) });
  });
  // Clearing before the picker opens keeps the chosen file name visible after
  // selection while still allowing the same file to be chosen again.
  imageInput.addEventListener("click", () => { imageInput.value = ""; });
  imageInput.addEventListener("change", () => { void onImageChange(); });
  dialog.addEventListener("toggle", () => {
    if (!dialog.open) { clearPreview(); setStatus(""); return; }
    syncControls(readStored());
    setStatus("");
  });

  app.applyChatBackground = apply;
  apply();
}