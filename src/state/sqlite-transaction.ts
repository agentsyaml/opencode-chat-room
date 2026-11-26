import { isBusyError, type StateDatabase } from "./sqlite.ts";

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function immediate<T>(db: StateDatabase, fn: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return db.transaction(fn).immediate(); }
    catch (error) {
      if (!isBusyError(error) || attempt >= 7) throw error;
      await pause(Math.min(20 * 2 ** attempt, 250));
    }
  }
}
