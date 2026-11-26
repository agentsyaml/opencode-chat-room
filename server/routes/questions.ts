// Room question listing and answer submission.
import { answerQuestion, readQuestions, readState } from "../../src/state/store.ts";
import { touchActive, wakeMentionedSessions } from "../wake.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function questionRoutes(req: Request, url: URL, serveWakeUrl: string): Promise<Response | undefined> {
  const questions = url.pathname.match(/^\/rooms\/([^/]+)\/questions$/);
  if (req.method === "GET" && questions) {
    const roomId = decodeURIComponent(questions[1]!);
    const exists = await readState((svc) => svc.listRooms().some((room) => room.id === roomId));
    if (!exists) return json({ error: "room not found" }, 404);
    return json({ questions: await readQuestions(roomId) });
  }
  const answer = url.pathname.match(/^\/rooms\/([^/]+)\/questions\/([^/]+)\/answers$/);
  if (req.method === "POST" && answer) {
    const roomId = decodeURIComponent(answer[1]!);
    const questionID = decodeURIComponent(answer[2]!);
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "sessionID and non-empty text (max 5000) are required" }, 400);
    const input = body as Record<string, unknown>;
    if (typeof input.sessionID !== "string" || !input.sessionID || typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 5000) return json({ error: "sessionID and non-empty text (max 5000) are required" }, 400);
    const result = await answerQuestion(roomId, questionID, input.sessionID, input.text.trim());
    if (result.status === "missing") return json({ error: "room not found" }, 404);
    if (result.status === "question") return json({ error: "question not found" }, 404);
    if (result.status === "member") return json({ error: "session is not a room member" }, 409);
    if (result.status === "answered") return json({ error: "question already answered" }, 409);
    if (result.status !== "ok") return json({ error: "question not found" }, 404);
    touchActive(input.sessionID);
    const room = await readState((svc) => svc.getRoom(roomId));
    void wakeMentionedSessions(serveWakeUrl, roomId, room.name, result.answer.text, input.sessionID, result.answer);
    return json({ questionID, answer: result.answer }, 201);
  }
  return undefined;
}