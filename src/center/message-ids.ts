// Message IDs ride inside the text prefix so the 300-char line budget never
// truncates the ID an agent needs for recall.
export function withMessageIds<T extends { id?: string; text: string }>(items: readonly T[]): T[] {
  return items.map((item) => item.id && !item.text.startsWith(`(id: ${item.id}) `)
    ? { ...item, text: `(id: ${item.id}) ${item.text}` }
    : item);
}