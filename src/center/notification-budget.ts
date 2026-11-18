// Mirror of MAX_LINES in formatNotificationLines: format keeps the newest
// lines, so an admission must instead carry the oldest prefix that fits.
// Otherwise bumping its maxTs would skip unrendered older messages.
const MAX_NOTIFICATION_LINES = 20;

export function notificationPrefix<T extends { id?: string; senderId: string; text: string; createdAt: number; answerQuestionExcerpt?: string }>(items: readonly T[]): T[] {
  let lines = 0;
  let end = 0;
  for (const item of items) {
    const needed = item.answerQuestionExcerpt ? 2 : 1;
    if (lines + needed > MAX_NOTIFICATION_LINES) break;
    lines += needed;
    end++;
  }
  return items.slice(0, end);
}