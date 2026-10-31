import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "../src/client.js";

const dispatched: string[] = [];
vi.mock("../src/inbound.js", () => ({
  dispatchSwarmInbound: vi.fn(async ({ item }: { item: InboxItem }) => {
    dispatched.push(item.id);
    return { dispatched: true };
  }),
}));

const { SwarmAccountWorker } = await import("../src/gateway.js");
const { resolveAccount } = await import("../src/accounts.js");
const { StateFile } = await import("../src/state.js");

const dm = (id: string, sender: string, data: InboxItem["data"] = []): InboxItem => ({
  id,
  sender_bot_id: sender,
  sender_display_name: sender.toUpperCase(),
  message: { role: "user", parts: [{ kind: "text", text: `hi from ${sender}` }] },
  data,
  status: { state: "submitted" },
});

function setup(policy: "pairing" | "open" = "pairing") {
  const store = new Set<string>();
  const pairingRequests: Array<{ id: string; meta?: Record<string, unknown> }> = [];
  const channelRuntime = {
    pairing: {
      readAllowFromStore: vi.fn(async () => [...store]),
      upsertPairingRequest: vi.fn(async (p: { id: string; meta?: Record<string, unknown> }) => {
        pairingRequests.push(p);
        return { code: "ABCD2345", created: true };
      }),
    },
  };
  const messages = new Map<string, InboxItem>();
  const client = {
    ack: vi.fn(async () => ({})),
    acceptRequest: vi.fn(async () => ({})),
    addFriend: vi.fn(async () => ({})),
    friends: vi.fn(async () => ["friend"]),
    getMessage: vi.fn(async (id: string) => messages.get(id)),
  };
  const account = resolveAccount(
    { channels: { swarmdm: { token: "bt_test", dmPolicy: policy } } } as never,
    null,
    {},
  );
  const state = new StateFile(StateFile.pathFor(mkdtempSync(path.join(tmpdir(), "swarmdm-w-")), "default"));
  const worker = new SwarmAccountWorker(
    account,
    {} as never,
    channelRuntime as never,
    client as never,
    "me",
    state,
  );
  return { worker, client, store, pairingRequests, messages, state };
}

describe("SwarmAccountWorker", () => {
  beforeEach(() => {
    dispatched.length = 0;
  });

  it("wakes the agent for friends and acks first", async () => {
    const { worker, client } = setup();
    await worker.refreshFriends(true);
    await worker.drain([dm("m1", "friend")]);
    expect(client.ack).toHaveBeenCalledWith("m1");
    expect(dispatched).toEqual(["m1"]);
  });

  it("never handles the same DM twice", async () => {
    const { worker } = setup();
    await worker.refreshFriends(true);
    await worker.drain([dm("m1", "friend")]);
    await worker.drain([dm("m1", "friend")]);
    expect(dispatched).toEqual(["m1"]);
  });

  it("handles a batch oldest first and moves the cursor to the newest", async () => {
    const { worker, state } = setup("open");
    await worker.drain([dm("new", "x"), dm("old", "y")]);
    expect(dispatched).toEqual(["old", "new"]);
    expect(state.cursor).toBe("new");
  });

  it("friend request → pairing request → approval accepts it on SwarmDM", async () => {
    const { worker, client, store, pairingRequests } = setup();
    const request = dm("n1", "ada", [
      { agoradigest: "friend_request", event: "request", request_id: "fr_1", from: "ada", from_display_name: "Ada", note: "hello" },
    ]);
    await worker.drain([request]);
    expect(dispatched).toEqual([]);
    expect(pairingRequests[0]).toMatchObject({ id: "ada", meta: { friendRequest: "fr_1", name: "Ada" } });
    expect(client.ack).toHaveBeenCalledWith("n1");

    await worker.syncApprovals();
    expect(client.acceptRequest).not.toHaveBeenCalled();

    store.add("ada"); // openclaw pairing approve swarmdm ABCD2345
    await worker.syncApprovals();
    expect(client.acceptRequest).toHaveBeenCalledWith("fr_1");

    // The held DMs now arrive as normal mail from a friend.
    await worker.drain([dm("held1", "ada")]);
    expect(dispatched).toEqual(["held1"]);
  });

  it("parks a stranger's DM (open SwarmDM policy) and answers it once approved", async () => {
    const { worker, client, store, pairingRequests, messages } = setup();
    const stranger = dm("s1", "stranger");
    messages.set("s1", stranger);
    await worker.drain([stranger]);
    expect(dispatched).toEqual([]);
    expect(client.ack).not.toHaveBeenCalled();
    expect(pairingRequests[0]).toMatchObject({ id: "stranger", meta: { firstMessage: "s1" } });

    store.add("stranger");
    await worker.syncApprovals();
    expect(client.addFriend).toHaveBeenCalledWith("stranger");
    expect(dispatched).toEqual(["s1"]);
  });

  it("stops waking the agent when one peer uses up its hourly budget", async () => {
    const { worker } = setup("open");
    const items = Array.from({ length: 22 }, (_, i) => dm(`b${i}`, "chatty"));
    await worker.drain(items.reverse());
    expect(dispatched).toHaveLength(20);
  });
});
