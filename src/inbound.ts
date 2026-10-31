import { createChannelInboundEnvelopeBuilderAsync } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isReasoningReplyPayload,
  isReplyPayloadTerminalContent,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { CHANNEL_ID, type ResolvedSwarmAccount } from "./accounts.js";
import { GUIDE_BOT_ID } from "./access.js";
import { partsText, SwarmDMError, type InboxItem, type SwarmDMClient } from "./client.js";

/** Peers get answers only: never reasoning, commentary, status/fallback
 * notices or host errors ("couldn't sign in to the AI service…"), which are
 * for the owner and would leak setup details to another person's agent. */
export function filterReplyPayload(payload: ReplyPayload): ReplyPayload | null {
  if (
    payload.isError ||
    payload.isCommentary ||
    payload.isStatusNotice ||
    payload.isFallbackNotice ||
    payload.isCompactionNotice ||
    isReasoningReplyPayload(payload) ||
    !isReplyPayloadTerminalContent(payload)
  ) {
    return null;
  }
  return payload;
}

/** What the agent reads: the DM text, any attachments named (not fetched),
 * and who sent it. The platform's sender name is self-declared. */
export function inboundBodyForAgent(item: InboxItem): string {
  const text = partsText(item.message?.parts);
  const files = (item.attachments ?? [])
    .map((a) => a.name ?? a.filename ?? a.file_id ?? a.id)
    .filter(Boolean);
  const fileLine = files.length ? `\n[attached: ${files.join(", ")} — not downloaded]` : "";
  return `${text}${fileLine}`.trim();
}

/** Answers one inbound DM: the first reply completes it (submit), later ones
 * thread onto it as new DMs. A DM that was already closed falls back to a thread. */
export function createReplySender(client: SwarmDMClient, messageId: string) {
  let answered = false;
  return async (text: string): Promise<void> => {
    const body = text.trim();
    if (!body) return;
    if (!answered) {
      try {
        await client.submit(messageId, body);
        answered = true;
        return;
      } catch (error) {
        if (!(error instanceof SwarmDMError && (error.status === 409 || error.status === 404))) {
          throw error;
        }
      }
    }
    await client.send({ inReplyTo: messageId, parts: [{ kind: "text", text: body }] });
    answered = true;
  };
}

export async function dispatchSwarmInbound(params: {
  account: ResolvedSwarmAccount;
  config: OpenClawConfig;
  channelRuntime: PluginRuntime["channel"];
  client: SwarmDMClient;
  selfBotId: string;
  item: InboxItem;
  allowFrom: string[];
  log?: { warn?: (msg: string) => void };
}): Promise<{ dispatched: boolean }> {
  const { item, account, channelRuntime } = params;
  const peer = item.sender_bot_id;
  const peerName = item.sender_display_name?.trim() || peer;
  const text = inboundBodyForAgent(item);
  const reply = createReplySender(params.client, item.id);

  // Other agents send tasks, never operator slash commands.
  if (text.trimStart().startsWith("/")) {
    await reply(
      "Slash commands are for this agent's owner only. Send your request as plain text.",
    );
    return { dispatched: false };
  }
  if (!text) return { dispatched: false };

  const route = resolveAgentRoute({
    cfg: params.config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: peer },
    // Remote agents never land in the owner's main session: one isolated
    // session per SwarmDM peer, whatever session.dmScope says.
    dmScope: "per-account-channel-peer",
  });
  const target = `${CHANNEL_ID}:${peer}`;
  const ingress = await channelRuntime.inbound.ingress.resolveStable({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    cfg: params.config,
    identity: { key: "sender", entryIdPrefix: "swarmdm-entry" },
    subject: { stableId: peer },
    conversation: { kind: "direct", id: peer },
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId: item.id,
      inboundEventKind: "user_request",
    },
    dmPolicy: account.dmPolicy === "open" ? "open" : "allowlist",
    allowFrom: account.dmPolicy === "open" ? ["*"] : [...params.allowFrom, GUIDE_BOT_ID],
  });
  if (ingress.ingress.admission !== "dispatch") {
    return { dispatched: false };
  }

  const timestamp = item.created_at ? Date.parse(item.created_at) || Date.now() : Date.now();
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({
    cfg: params.config,
    route,
  });
  const fromLabel = item.sender_owner_name
    ? `${peerName} (${peer}, agent of ${item.sender_owner_name})`
    : `${peerName} (${peer})`;
  const body = buildEnvelope({ channel: "SwarmDM", from: fromLabel, timestamp, body: text });
  const ctxPayload = channelRuntime.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: route.accountId ?? account.accountId,
    messageId: item.id,
    messageIdFull: item.id,
    timestamp,
    from: target,
    sender: { id: peer, name: peerName },
    conversation: { kind: "direct", id: peer, label: peerName },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: { to: target, originatingTo: target, replyToId: item.in_reply_to ?? undefined },
    message: { body, bodyForAgent: text, rawBody: text, commandBody: text },
    channelIngress: ingress,
    extra: { CommandInterpretationSuppressed: true },
  });

  const dispatch = await channelRuntime.inbound.dispatch({
    cfg: params.config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
    ctxPayload,
    delivery: {
      deliver: async (payload, info) => {
        if (info.kind !== "final" || filterReplyPayload(payload) === null) return;
        await reply(payload.text ?? "");
      },
      onError: (error) => {
        params.log?.warn?.(`[swarmdm] reply to ${item.id} failed: ${String(error)}`);
      },
    },
    replyOptions: { sourceReplyDeliveryMode: "automatic" },
    replyPipeline: {},
  });
  return { dispatched: dispatch.admission.kind === "dispatch" && Boolean(dispatch.dispatched) };
}
