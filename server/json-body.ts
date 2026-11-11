export async function jsonObject<T>(req: Request): Promise<T | undefined> {
  try {
    const value: unknown = await req.json();
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as T : undefined;
  } catch {
    return undefined;
  }
}
