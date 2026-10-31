import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  channelBlockedPatch,
  channelReadyPatch,
  channelStoppedPatch,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { CHANNEL_ID, normalizeBotId, type ResolvedSwarmAccount } from "./accounts.js";
import { configuredOwners, decideAccess, OWNER_REMEDIATION, PeerBudget, swarmOwners } from "./access.js";
import { SwarmDMClient, SwarmDMError, type InboxItem } from "./client.js";
import { dispatchSwarmInbound } from "./inbound.js";
import { getSwarmRuntime } from "./runtime.js";
import { StateFile } from "./state.js";

const POLL_WAIT_SECONDS = 25;
const FRIENDS_REFRESH_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;

type Log = ChannelGatewayContext<ResolvedSwarmAccount>["log"];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

/** One SwarmDM identity, polled for the lifetime of the account. */
export class SwarmAccountWorker {
  private friends = new Set<string>();
  private friendsAt = 0;
  private readonly budget: PeerBudget;

  constructor(
    readonly account: ResolvedSwarmAccount,
    private readonly cfg: OpenClawConfig,
    private readonly channelRuntime: PluginRuntime["channel"],
    readonly client: SwarmDMClient,
    readonly selfBotId: string,
    private readonly state: StateFile,
    private readonly log?: Log,
  ) {
    this.budget = new PeerBudget(account.maxTurnsPerPeerPerHour);
  }

  private async approved(): Promise<Set<string>> {
    try {
      const list = await this.channelRuntime.pairing.readAllowFromStore({
        channel: CHANNEL_ID,
        accountId: this.account.accountId,
      });
      return new Set(list.map((x) => normalizeBotId(String(x))));
    } catch {
      return new Set();
    }
  }

  async refreshFriends(force = false): Promise<void> {
    if (!force && Date.now() - this.friendsAt < FRIENDS_REFRESH_MS) return;
    this.friends = new Set(await this.client.friends());
    this.friendsAt = Date.now();
  }

  /** Owner approved a pairing request (CLI, Control UI): make it real on
   * SwarmDM. A held friend request is accepted (its DMs then arrive as normal
   * mail); a parked DM's sender is added as a friend and the DM handled. */
  async syncApprovals(): Promise<void> {
    const approved = await this.approved();
    for (const { sender, requestId } of this.state.pendingRequests()) {
      if (!approved.has(sender)) continue;
      try {
        await this.client.acceptRequest(requestId);
        this.log?.info?.(`[swarmdm] accepted friend request from ${sender}`);
      } catch (error) {
        // Already accepted/declined/expired elsewhere (e.g. in the phone app).
        if (!(error instanceof SwarmDMError && [404, 409, 410].includes(error.status))) throw error;
      }
      this.friends.add(sender);
      this.state.forgetRequest(sender);
    }
    for (const sender of this.state.parkedSenders()) {
      if (!approved.has(sender)) continue;
      await this.client.addFriend(sender).catch(() => undefined);
      this.friends.add(sender);
      for (const id of this.state.takeParked(sender)) {
        const item = await this.client.getMessage(id).catch(() => null);
        if (item && (item.status?.state ?? "submitted") === "submitted") {
          await this.dispatch(item, approved);
        }
      }
    }
  }

  private async upsertPairing(sender: string, meta: Record<string, string | undefined>) {
    const r = await this.channelRuntime.pairing.upsertPairingRequest({
      channel: CHANNEL_ID,
      id: sender,
      accountId: this.account.accountId,
      meta,
    });
    if (r.created) {
      const noOwner = configuredOwners(this.cfg).length === 0;
      this.log?.info?.(
        `[swarmdm] ${meta.name ?? sender} (${sender}) asks to talk to this agent. ` +
          (noOwner
            ? `Approve it in the Control UI (Settings → Channels → DM access requests). ` +
              `No command owner is set, so \`openclaw pairing approve\` would make this agent your owner. ${OWNER_REMEDIATION}`
            : `Approve: openclaw pairing approve ${CHANNEL_ID} ${r.code}`),
      );
    }
  }

  private async dispatch(item: InboxItem, approved: Set<string>): Promise<void> {
    const sender = item.sender_bot_id;
    await this.client.ack(item.id).catch(() => undefined);
    this.budget.record(sender);
    await dispatchSwarmInbound({
      account: this.account,
      config: this.cfg,
      channelRuntime: this.channelRuntime,
      client: this.client,
      selfBotId: this.selfBotId,
      item,
      allowFrom: [...this.friends, ...approved],
      log: this.log,
    });
  }

  async handle(item: InboxItem): Promise<void> {
    if (!item.id || this.state.hasSeen(item.id)) return;
    const approved = await this.approved();
    const decision = decideAccess({
      item,
      selfBotId: this.selfBotId,
      policy: this.account.dmPolicy,
      friends: this.friends,
      approved,
      overBudget: this.budget.wouldExceed(item.sender_bot_id),
    });
    // Recorded before any agent work, so a crash never answers a DM twice.
    this.state.markSeen(item.id);
    switch (decision.kind) {
      case "friend_request":
        this.state.rememberRequest(decision.from, decision.requestId);
        await this.client.ack(item.id).catch(() => undefined);
        await this.upsertPairing(decision.from, {
          name: decision.name,
          note: decision.note?.slice(0, 200),
          friendRequest: decision.requestId,
        });
        return;
      case "park":
        this.state.park(item.sender_bot_id, item.id);
        await this.upsertPairing(item.sender_bot_id, {
          name: item.sender_display_name ?? undefined,
          firstMessage: item.id,
        });
        return;
      case "throttle":
        this.log?.warn?.(
          `[swarmdm] ${item.sender_bot_id} hit ${this.account.maxTurnsPerPeerPerHour} turns/hour; DM ${item.id} left unanswered`,
        );
        return;
      case "skip":
        return;
      case "dispatch":
        await this.dispatch(item, approved);
        return;
    }
  }

  /** Oldest first, newest last; the cursor follows. */
  async drain(items: InboxItem[]): Promise<void> {
    for (const item of [...items].reverse()) {
      try {
        await this.handle(item);
      } catch (error) {
        this.log?.warn?.(`[swarmdm] DM ${item.id} failed: ${String(error)}`);
      }
      this.state.setCursor(item.id);
    }
  }
}

export async function startSwarmGatewayAccount(ctx: ChannelGatewayContext<ResolvedSwarmAccount>) {
  const account = ctx.account;
  if (!account.configured) {
    ctx.setStatus(
      channelBlockedPatch("No SwarmDM token: run `openclaw channels add swarmdm`", {
        accountId: account.accountId,
      }),
    );
    return;
  }
  const channelRuntime =
    (ctx.channelRuntime as PluginRuntime["channel"] | undefined) ?? getSwarmRuntime().channel;
  const client = new SwarmDMClient(account.token, account.apiBase);
  ctx.setStatus({ accountId: account.accountId, running: true, configured: true, enabled: true });

  let me: { bot_id: string; display_name?: string | null };
  try {
    me = await client.me(ctx.abortSignal);
  } catch (error) {
    const msg =
      error instanceof SwarmDMError && error.status === 401
        ? "SwarmDM rejected the token (401): check channels.swarmdm.token"
        : `SwarmDM unreachable: ${String(error)}`;
    ctx.setStatus(channelBlockedPatch(msg, { accountId: account.accountId }));
    if (error instanceof SwarmDMError && error.status === 401) return;
    throw error;
  }
  const state = new StateFile(StateFile.pathFor(resolveStateDir(), account.accountId));
  const worker = new SwarmAccountWorker(
    account,
    ctx.cfg,
    channelRuntime,
    client,
    me.bot_id,
    state,
    ctx.log,
  );
  activeWorkers.set(account.accountId, worker);
  ctx.log?.info?.(
    `[swarmdm] ${me.display_name ?? me.bot_id} (${me.bot_id}) listening, dmPolicy=${account.dmPolicy}`,
  );
  const peerOwners = swarmOwners(ctx.cfg);
  if (peerOwners.length > 0) {
    ctx.log?.warn?.(
      `[swarmdm] SECURITY: ${peerOwners.join(", ")} ${peerOwners.length === 1 ? "is" : "are"} OpenClaw command owner(s). ` +
        `SwarmDM senders are other people's agents. Remove them from commands.ownerAllowFrom. ${OWNER_REMEDIATION}`,
    );
  }

  let backoff = 2_000;
  let ready = false;
  try {
    while (!ctx.abortSignal.aborted) {
      try {
        await worker.refreshFriends();
        await worker.syncApprovals();
        const items = await client.inbox({
          waitSeconds: state.cursor ? POLL_WAIT_SECONDS : 0,
          after: state.cursor,
          signal: ctx.abortSignal,
        });
        if (!ready) {
          ready = true;
          ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
        }
        await worker.drain(items);
        backoff = 2_000;
      } catch (error) {
        if (ctx.abortSignal.aborted) break;
        if (error instanceof SwarmDMError && error.status === 401) {
          ctx.setStatus(
            channelBlockedPatch("SwarmDM token revoked (401)", { accountId: account.accountId }),
          );
          return;
        }
        ctx.setStatus({ accountId: account.accountId, connected: false, lastError: String(error) });
        ctx.log?.warn?.(`[swarmdm] poll failed, retrying in ${backoff / 1000}s: ${String(error)}`);
        await sleep(backoff + Math.floor(Math.random() * 1000), ctx.abortSignal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  } finally {
    activeWorkers.delete(account.accountId);
    ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
  }
}

/** Running workers, so a pairing approval can be applied at once. */
export const activeWorkers = new Map<string, SwarmAccountWorker>();
