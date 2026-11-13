import { matchesHash, type Binding } from "./admin-state";

export function agentHeadersMatch(request: Request, binding: Binding): boolean {
  return request.headers.get("x-chat-agent-session") === binding.session_id &&
    (request.headers.get("x-chat-agent-owner") ?? "") === binding.receiver_owner_id;
}

export function hasAdminCapability(request: Request, binding: Binding): boolean {
  if (!agentHeadersMatch(request, binding)) return false;
  // Owner designation is the grant; the optional claim capability is legacy.
  if (!binding.capability_hash) return true;
  return matchesHash(request.headers.get("x-chat-admin-capability") ?? "", binding.capability_hash);
}
