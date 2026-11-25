import type { ChannelConfig, RuleTarget } from "./config.ts";
import type { Endpoint } from "./protocol.ts";

export function parseTarget(value: string): Endpoint | undefined {
  const parts = value.split("/");
  if (parts.length !== 3) return undefined;
  const [platform, accountId, roomId] = parts;
  if (!platform || !accountId || !roomId) return undefined;
  return { platform, accountId, roomId };
}

export function startFailureReason(accountId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = `adapter ${accountId} failed to start: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

export function validateTargets(config: ChannelConfig): void {
  const accounts = new Map(config.accounts.map((account) => [account.id, account]));
  for (const rule of config.rules) {
    for (const target of rule.to) {
      const account = accounts.get(target.account);
      if (!account) {
        throw new Error(`config: rule "${rule.id}" targets unknown account "${target.account}"`);
      }
      if (account.platform !== target.platform) {
        throw new Error(
          `config: rule "${rule.id}" targets platform "${target.platform}" but account "${target.account}" is "${account.platform}"`,
        );
      }
    }
  }
}

export function toEndpoint(config: ChannelConfig, ruleId: string, target: RuleTarget): Endpoint {
  const account = config.accounts.find((item) => item.id === target.account);
  if (!account) {
    throw new Error(`config: rule "${ruleId}" targets unknown account "${target.account}"`);
  }
  return { platform: target.platform, accountId: account.id, roomId: target.room };
}