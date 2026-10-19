import { readHistory, readState } from "../src/store";

export async function historyRoute(url: URL): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/rooms\/([^/]+)\/history$/);
  if (!match) return undefined;
  const roomID = decodeURIComponent(match[1]!);
  const beforeText = url.searchParams.get("beforeSeq");
  const before = beforeText === null ? undefined : Number(beforeText);
  const excludeSessionID = url.searchParams.get("excludeSessionID");
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? 100 : Number(limitText);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1) ||
      !Number.isInteger(limit) || limit < 1 || limit > 200 ||
      excludeSessionID !== null && (!excludeSessionID || excludeSessionID.length > 128)) {
    return Response.json({ error: "invalid history cursor or limit" }, { status: 400 });
  }
  const access = await readState((service, registry) => ({
    exists: service.listRooms().some((room) => room.id === roomID),
    member: excludeSessionID ? registry[roomID]?.[excludeSessionID] : undefined,
  }));
  if (!access.exists || excludeSessionID && !access.member) return Response.json({ error: "room not found" }, { status: 404 });
  const page = await readHistory(roomID, before, limit, access.member && excludeSessionID
    ? { sessionID: excludeSessionID, name: access.member.name } : undefined);
  return Response.json({ ...page, messages: page.messages.map(({ senderSessionID: _sid, ...message }) => message) });
}
