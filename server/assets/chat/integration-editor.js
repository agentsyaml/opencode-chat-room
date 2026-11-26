// Lazy Monaco wrapper for one integration rules section. The textarea stays in the
// page as the no-JS and failed-download fallback, so this module never imports Monaco.
const BUNDLE_URL = "/assets/monaco/integration-rules.js";
const STYLES_URL = "/assets/monaco/integration-rules.css";
let bundlePromise = null;

function loadBundle() {
  if (!bundlePromise) {
    bundlePromise = import(BUNDLE_URL)
      .then((module) => {
        if (!document.querySelector("link[data-integration-rules-editor]")) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = STYLES_URL;
          link.dataset.integrationRulesEditor = "true";
          document.head.append(link);
        }
        return module;
      })
      .catch((error) => {
        // Keep this a warning: a blocked asset must not surface as an uncaught page error.
        console.warn("Integration code editor unavailable; keeping the plain text editor.", error);
        throw error;
      });
  }
  return bundlePromise;
}

export function initIntegrationEditor(app, options) {
  const host = app.$(options.editor);
  const textarea = app.$(options.textarea);
  const fallback = app.$(options.fallback);
  const error = app.$(options.error);
  const errorList = app.$(options.errors);
  const formatGroup = app.$(options.formats);
  let controller = null, loading = null, failed = false, editable = true;

  if (formatGroup) formatGroup.hidden = true;

  const applyEditable = () => {
    host?.setAttribute("data-read-only", String(!editable));
    if (textarea) textarea.readOnly = !editable;
    for (const button of formatGroup?.querySelectorAll("[data-format]") || []) button.disabled = !editable;
    controller?.setReadOnly(!editable);
  };

  const updateFormatButtons = () => {
    const active = controller?.getFormat() || "json";
    for (const button of formatGroup?.querySelectorAll("[data-format]") || []) {
      button.setAttribute("aria-pressed", String(button.dataset.format === active));
    }
  };

  const render = (result) => {
    if (textarea) textarea.value = result.text;
    host?.setAttribute("data-error-count", String(result.errors.length));
    host?.setAttribute("aria-invalid", String(result.errors.length > 0));
    updateFormatButtons();
    if (!error || !errorList) return;
    errorList.textContent = "";
    if (!result.errors.length) {
      error.hidden = true;
      errorList.hidden = true;
      return;
    }
    const first = result.errors[0];
    error.textContent = app.t("integrationsRulesErrors", {
      count: result.errors.length,
      first: `Line ${first.line}: ${first.message}`,
    });
    error.hidden = false;
    errorList.hidden = false;
    for (const issue of result.errors) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "integration-rule-error";
      button.textContent = `Line ${issue.line}${issue.path ? ` · ${issue.path}` : ""}: ${issue.message}`;
      button.addEventListener("click", () => controller?.reveal(issue.line, issue.column));
      item.append(button);
      errorList.append(item);
    }
  };

  const clearErrors = () => {
    if (error) error.hidden = true;
    if (errorList) { errorList.hidden = true; errorList.textContent = ""; }
    host?.setAttribute("data-error-count", "0");
    host?.removeAttribute("aria-invalid");
  };

  const ensure = () => {
    if (controller || failed || !host) return loading;
    if (loading) return loading;
    loading = loadBundle().then((module) => {
      controller = module.createIntegrationRulesEditor({
        kind: options.kind,
        container: host,
        value: options.getValue(),
        accounts: options.getAccounts(),
        onChange: render,
      });
      host.hidden = false;
      if (textarea) textarea.hidden = true;
      if (fallback) fallback.hidden = true;
      if (formatGroup) formatGroup.hidden = false;
      applyEditable();
      render(controller.validate());
    }).catch(() => {
      failed = true;
      if (fallback) {
        fallback.textContent = app.t("integrationsEditorUnavailable");
        fallback.hidden = false;
      }
    }).finally(() => { loading = null; });
    return loading;
  };

  const refresh = () => {
    const value = options.getValue() ?? [];
    clearErrors();
    if (controller) controller.setValue(value);
    else if (textarea) textarea.value = JSON.stringify(value, null, 2);
  };

  const current = () => {
    if (controller) {
      const result = controller.validate();
      render(result);
      return { editor: true, ...result };
    }
    return { editor: false, text: textarea?.value || "", errors: [] };
  };

  for (const button of formatGroup?.querySelectorAll("[data-format]") || []) {
    button.addEventListener("click", () => {
      if (!controller || !editable) return;
      controller.setFormat(button.dataset.format === "yaml" ? "yaml" : "json");
      updateFormatButtons();
    });
  }
  textarea?.addEventListener("input", clearErrors);

  return {
    ensure,
    refresh,
    current,
    showMessage: (message) => {
      if (!error) return;
      error.textContent = message;
      error.hidden = false;
      if (errorList) { errorList.hidden = true; errorList.textContent = ""; }
    },
    setAccounts: (accounts) => controller?.setAccounts(accounts),
    setEditable: (next) => {
      editable = next !== false;
      applyEditable();
    },
    getText: () => textarea?.value || "",
    hasEditor: () => Boolean(controller),
    dispose: () => controller?.dispose(),
  };
}