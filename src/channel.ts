import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import {
  CHANNEL_ID,
  channelSection,
  defaultAccountId,
  inspectAccount,
  listAccountIds,
  normalizeBotId,
  resolveAccount,
  type ResolvedSwarmAccount,
  type SwarmAccountConfig,
} from "./accounts.js";
import { INBOUND_RULES, MESSAGE_TOOL_HINTS, OWNER_REMEDIATION, swarmOwners } from "./access.js";
import { activeWorkers, startSwarmGatewayAccount } from "./gateway.js";
import { sendSwarmText } from "./outbound.js";

export const swarmMeta = {
  id: CHANNEL_ID,
  label: "SwarmDM",
  selectionLabel: "SwarmDM (agent-to-agent DMs)",
  docsPath: "https://github.com/swarmdm/openclaw-swarmdm#readme",
  blurb:
    "Give your agent a SwarmDM address: other agents' DMs wake it, replies go back as DMs. No public URL needed.",
  aliases: ["swarm"],
};

const SETUP_KEYS = ["token", "tokenFile", "apiBase", "dmPolicy", "name"] as const;

/** Writes the setup input into channels.swarmdm (or channels.swarmdm.accounts.<id>). */
export function applySwarmAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  input: Record<string, unknown>;
}): OpenClawConfig {
  const patch: SwarmAccountConfig = {};
  for (const key of SETUP_KEYS) {
    const value = params.input[key];
    if (typeof value === "string" && value.trim()) {
      (patch as Record<string, string>)[key] = value.trim();
    }
  }
  const section = channelSection(params.cfg) ?? {};
  const id = params.accountId?.trim();
  const next =
    id && id !== "default"
      ? { ...section, accounts: { ...(section.accounts ?? {}), [id]: { ...(section.accounts?.[id] ?? {}), ...patch } } }
      : { ...section, ...patch };
  return { ...params.cfg, channels: { ...(params.cfg.channels ?? {}), [CHANNEL_ID]: next } };
}

export const swarmChannelPlugin: ChannelPlugin<ResolvedSwarmAccount> =
  createChatChannelPlugin<ResolvedSwarmAccount>({
    base: {
      id: CHANNEL_ID,
      meta: swarmMeta,
      capabilities: { chatTypes: ["direct"] },
      reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
      configSchema: buildJsonChannelConfigSchema(manifest.channelConfigs.swarmdm.schema),
      config: {
        listAccountIds: (cfg) => listAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
        defaultAccountId: (cfg) => defaultAccountId(cfg),
        isConfigured: (account) => account.configured,
        inspectAccount: (cfg, accountId) => inspectAccount(cfg, accountId),
        describeAccount: (account) => ({
          accountId: account.accountId,
          name: account.name ?? "SwarmDM",
          enabled: account.enabled,
          configured: account.configured,
        }),
      },
      setup: {
        applyAccountConfig: ({ cfg, accountId, input }) =>
          applySwarmAccountConfig({ cfg, accountId, input: input as Record<string, unknown> }),
      },
      gateway: {
        startAccount: (ctx) => startSwarmGatewayAccount(ctx),
      },
      agentPrompt: {
        inboundFormattingHints: () => ({ text_markup: "plain", rules: INBOUND_RULES }),
        messageToolHints: () => MESSAGE_TOOL_HINTS,
      },
      messaging: {
        normalizeTarget: (raw) => {
          const id = normalizeBotId(raw);
          return id ? `${CHANNEL_ID}:${id}` : undefined;
        },
        targetResolver: {
          looksLikeId: (raw) => /^(swarmdm:|swarm:)?[A-Za-z0-9_\-.一-鿿]{2,64}$/.test(raw.trim()),
          hint: "<swarmdm:bot_id>",
        },
      },
    },
    security: {
      dm: {
        channelKey: CHANNEL_ID,
        // pairing = SwarmDM friends wake the agent; strangers go through friend requests.
        resolvePolicy: (account) => (account.dmPolicy === "pairing" ? "pairing" : account.dmPolicy),
        resolveAllowFrom: () => [],
        defaultPolicy: "pairing",
        approveHint: `openclaw pairing approve ${CHANNEL_ID} <CODE>`,
        normalizeEntry: normalizeBotId,
      },
      collectWarnings: ({ cfg }) => {
        const owners = swarmOwners(cfg);
        if (owners.length === 0) return [];
        return [
          {
            checkId: "swarmdm.peer-is-command-owner",
            severity: "critical",
            title: "A SwarmDM agent is an OpenClaw command owner",
            detail:
              `commands.ownerAllowFrom contains ${owners.join(", ")}. SwarmDM senders are other ` +
              "people's AI agents; as owners they could approve commands or change this Gateway. " +
              "This usually happens when the first `openclaw pairing approve` runs with no owner set.",
            remediation: `Remove those entries. ${OWNER_REMEDIATION}`,
          },
        ];
      },
    },
    pairing: {
      text: {
        idLabel: "SwarmDM bot_id",
        message: "Approved: your friend request was accepted.",
        normalizeAllowEntry: normalizeBotId,
        // Approval with --notify: apply it now instead of on the next poll.
        // SwarmDM tells the requester itself when the friend request is accepted.
        notify: async ({ accountId }) => {
          const worker = activeWorkers.get(accountId ?? "default");
          await worker?.syncApprovals();
        },
      },
    },
    threading: { topLevelReplyToMode: "reply" },
    outbound: {
      base: { deliveryMode: "direct" },
      attachedResults: {
        channel: CHANNEL_ID,
        sendText: async (ctx) => {
          const worker = activeWorkers.get(ctx.accountId ?? "default");
          const r = await sendSwarmText({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
            to: ctx.to,
            text: ctx.text,
            replyToId: ctx.replyToId,
            client: worker?.client,
          });
          return { messageId: r.messageId };
        },
      },
    },
  });
