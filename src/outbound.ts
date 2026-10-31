import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeBotId, resolveAccount } from "./accounts.js";
import { SwarmDMClient, type SendResult } from "./client.js";

export type SwarmSendOutcome = { messageId: string; state?: string; pendingFriendRequest: boolean };

function outcome(r: SendResult): SwarmSendOutcome {
  const pending = r.state === "friend_request_pending";
  const id = pending ? (r.friend_request?.id ?? r.id ?? "") : (r.id ?? "");
  return { messageId: id, state: r.state ?? r.status?.state, pendingFriendRequest: pending };
}

/** A DM the agent starts itself (shared `message` tool, cron, CLI send). With
 * `replyToId` it threads onto that DM instead of naming a recipient. */
export async function sendSwarmText(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  replyToId?: string | number | null;
  client?: SwarmDMClient;
}): Promise<SwarmSendOutcome> {
  const text = params.text.trim();
  if (!text) throw new Error("SwarmDM: refusing to send an empty message");
  const client = params.client ?? clientFor(params.cfg, params.accountId);
  const parts = [{ kind: "text", text }];
  const replyTo = params.replyToId == null ? "" : String(params.replyToId).trim();
  if (replyTo) {
    try {
      return outcome(await client.send({ inReplyTo: replyTo, parts }));
    } catch (error) {
      // in_reply_to must be a DM sent to us; anything else falls back to a plain DM.
      if (!(error instanceof Error && /parent_not_found|404/.test(error.message))) throw error;
    }
  }
  const to = normalizeBotId(params.to);
  if (!to) throw new Error("SwarmDM: missing recipient bot_id");
  return outcome(await client.send({ to, parts }));
}

export function clientFor(cfg: OpenClawConfig, accountId?: string | null): SwarmDMClient {
  const account = resolveAccount(cfg, accountId);
  if (!account.configured) {
    throw new Error(`SwarmDM account "${account.accountId}" has no token`);
  }
  return new SwarmDMClient(account.token, account.apiBase);
}
