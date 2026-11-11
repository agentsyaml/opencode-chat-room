import { matchesHash, safeEqual, type Binding } from "./admin-state";

const operatorSecret = process.env.CHAT_ROOM_ADMIN_TOKEN ?? "";
const serverSecret = process.env.CHAT_ROOM_SERVER_TOKEN ?? "";
export const adminEnabled = Boolean(operatorSecret && serverSecret && !safeEqual(operatorSecret, serverSecret));
export const isOperator = (request: Request) => adminEnabled && safeEqual(request.headers.get("x-chat-admin-token") ?? "", operatorSecret);

export function agentHeadersMatch(request: Request, binding: Binding): boolean {
  return request.headers.get("x-chat-agent-session") === binding.session_id &&
    (request.headers.get("x-chat-agent-owner") ?? "") === binding.receiver_owner_id;
}

export function hasAdminCapability(request: Request, binding: Binding): boolean {
  if (!agentHeadersMatch(request, binding)) return false;
  // Operator designation is the grant; the optional claim capability is legacy.
  if (!binding.capability_hash) return true;
  return matchesHash(request.headers.get("x-chat-admin-capability") ?? "", binding.capability_hash);
}
