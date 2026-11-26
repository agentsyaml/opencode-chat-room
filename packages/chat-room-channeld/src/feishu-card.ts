export type CardVersion = "1.0" | "2.0";

/**
 * FEISHU_CARD_VERSION is opt-in: card 1.0 keeps the 0.8.0 payload because some
 * tenants still render card 2.0 differently. Card 2.0 is required for headings,
 * lists, and fenced code as block Markdown.
 */
export function cardVersionFromEnv(value: string | undefined): CardVersion {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw || raw === "1" || raw === "1.0") return "1.0";
  if (raw === "2" || raw === "2.0") return "2.0";
  throw new Error("FEISHU_CARD_VERSION must be 1.0 or 2.0");
}

export function buildCard(version: CardVersion, text: string): unknown {
  if (version === "2.0") {
    return {
      schema: "2.0",
      config: { update_multi: true },
      body: { elements: [{ tag: "markdown", content: text }] },
    };
  }
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: "div", text: { tag: "lark_md", content: text } }],
  };
}