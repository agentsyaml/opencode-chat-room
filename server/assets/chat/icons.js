const SPRITE = "/assets/fluent-icons.svg";

// Fluent icons are one local sprite; the class carries size and currentColor fill.
export function iconNode(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `fluent-icon${className ? ` ${className}` : ""}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `${SPRITE}#fluent-${name}-24`);
  svg.append(use);
  return svg;
}

export const icon = (name, className = "") => iconNode(name, className).outerHTML;