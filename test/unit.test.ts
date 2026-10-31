import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectAccount, normalizeBotId, resolveAccount, resolveToken } from "../src/accounts.js";
import { decideAccess, PeerBudget } from "../src/access.js";
import {
  friendRequestOf,
  isSystemNotice,
  partsText,
  SwarmDMClient,
  SwarmDMError,
  type InboxItem,
} from "../src/client.js";
import { createReplySender, inboundBodyForAgent } from "../src/inbound.js";
import { StateFile } from "../src/state.js";
import { applySwarmAccountConfig } from "../src/channel.js";

const dm = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: "m1",
  sender_bot_id: "ada",
  sender_display_name: "Ada",
  message: { role: "user", parts: [{ kind: "text", text: "hello" }] },
  data: [],
  ...over,
});

const friendRequestDm = dm({
  id: "m2",
  data: [
    {
      agoradigest: "friend_request",
      event: "request",
      request_id: "fr_1",
      from: "ada",
      from_display_name: "Ada",
      note: "hi",
    },
  ],
});

describe("accounts", () => {
  const noEnv = {} as NodeJS.ProcessEnv;

  it("prefers config token, then tokenFile, then env", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "swarmdm-"));
    const file = path.join(dir, "token");
    writeFileSync(file, "bt_file\n");
    expect(resolveToken({ token: "bt_cfg", tokenFile: file }, "default", noEnv)).toEqual({
      token: "bt_cfg",
      source: "config",
    });
    expect(resolveToken({ tokenFile: file }, "default", noEnv)).toEqual({ token: "bt_file", source: "tokenFile" });
    expect(resolveToken({}, "default", { SWARMDM_TOKEN: "bt_env" })).toEqual({ token: "bt_env", source: "env" });
    // Named accounts never borrow the env / skill token.
    expect(resolveToken({}, "work", { SWARMDM_TOKEN: "bt_env" }).source).toBe("none");
  });

  it("merges named accounts over the root and defaults to pairing", () => {
    const cfg = {
      channels: {
        swarmdm: { apiBase: "https://staging.example/", accounts: { work: { token: "bt_w", dmPolicy: "open" } } },
      },
    } as never;
    const a = resolveAccount(cfg, "work", {});
    expect(a.token).toBe("bt_w");
    expect(a.apiBase).toBe("https://staging.example");
    expect(a.dmPolicy).toBe("open");
    const b = resolveAccount({ channels: { swarmdm: { token: "bt_x", dmPolicy: "weird" } } } as never, null, {});
    expect(b.dmPolicy).toBe("pairing");
  });

  it("inspectAccount never exposes the token", () => {
    const view = inspectAccount({ channels: { swarmdm: { token: "bt_secret" } } } as never);
    expect(JSON.stringify(view)).not.toContain("bt_secret");
    expect(view.configured).toBe(true);
  });

  it("normalizes targets to bare bot ids", () => {
    expect(normalizeBotId("swarmdm:bot_ab12")).toBe("bot_ab12");
    expect(normalizeBotId(" swarm:dm:guide ")).toBe("guide");
    expect(normalizeBotId("秘书")).toBe("秘书");
  });
});

describe("access", () => {
  const base = {
    selfBotId: "me",
    policy: "pairing" as const,
    friends: new Set(["friend"]),
    approved: new Set(["approved"]),
    overBudget: false,
  };

  it("lets friends, approved senders and guide wake the agent under pairing", () => {
    for (const sender of ["friend", "approved", "guide"]) {
      expect(decideAccess({ ...base, item: dm({ sender_bot_id: sender }) }).kind).toBe("dispatch");
    }
  });

  it("parks strangers under pairing and dispatches them under open", () => {
    expect(decideAccess({ ...base, item: dm() }).kind).toBe("park");
    expect(decideAccess({ ...base, policy: "open", item: dm() }).kind).toBe("dispatch");
  });

  it("turns friend requests into pairing requests whatever the policy", () => {
    const d = decideAccess({ ...base, policy: "open", item: friendRequestDm });
    expect(d).toMatchObject({ kind: "friend_request", requestId: "fr_1", from: "ada", note: "hi" });
  });

  it("skips own echoes, platform notices and a disabled channel; throttles over budget", () => {
    expect(decideAccess({ ...base, item: dm({ sender_bot_id: "me" }) }).kind).toBe("skip");
    expect(
      decideAccess({ ...base, item: dm({ sender_bot_id: "friend", data: [{ agoradigest: "friend_request", event: "accepted" }] }) }).kind,
    ).toBe("skip");
    expect(decideAccess({ ...base, policy: "disabled", item: dm({ sender_bot_id: "friend" }) }).kind).toBe("skip");
    expect(decideAccess({ ...base, overBudget: true, item: dm({ sender_bot_id: "friend" }) }).kind).toBe("throttle");
  });

  it("PeerBudget is a sliding hour per peer", () => {
    const b = new PeerBudget(2);
    b.record("a", 0);
    b.record("a", 1000);
    expect(b.wouldExceed("a", 2000)).toBe(true);
    expect(b.wouldExceed("b", 2000)).toBe(false);
    expect(b.wouldExceed("a", 3_600_500)).toBe(false);
  });
});

describe("client helpers", () => {
  it("reads text parts, friend requests and notices", () => {
    expect(partsText([{ kind: "text", text: "a" }, { kind: "file", file: { file_id: "f" } }, { kind: "text", text: "b" }])).toBe("a\nb");
    expect(friendRequestOf(friendRequestDm)?.requestId).toBe("fr_1");
    expect(friendRequestOf(dm())).toBeNull();
    expect(isSystemNotice(friendRequestDm)).toBe(true);
    expect(isSystemNotice(dm())).toBe(false);
  });

  it("names attachments without fetching them", () => {
    const body = inboundBodyForAgent(dm({ attachments: [{ file_id: "f1", name: "report.pdf" }] }));
    expect(body).toContain("hello");
    expect(body).toContain("report.pdf");
  });

  it("long-polls the inbox with cursor and sends threaded replies", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ tasks: [], id: "new" }), { status: 200 });
    });
    const c = new SwarmDMClient("bt_t", "https://api.example/", fetchImpl as never);
    await c.inbox({ waitSeconds: 99, after: "m9" });
    expect(calls[0]!.url).toBe("https://api.example/a2a/v1/messages/inbox?wait=50&after=m9&limit=50&state=submitted");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer bt_t");
    await c.send({ inReplyTo: "m1", parts: [{ kind: "text", text: "hi" }] });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      in_reply_to: "m1",
      message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
    });
    await c.checkName("Ada");
    expect((calls[2]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("turns API errors into SwarmDMError with the error code", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ detail: { error: "wrong_state" } }), { status: 409 });
    const c = new SwarmDMClient("bt", "https://api.example", fetchImpl as never);
    await expect(c.submit("m1", "x")).rejects.toMatchObject({ status: 409, code: "wrong_state" });
  });
});

describe("reply sender", () => {
  it("submits the first answer and threads later ones", async () => {
    const client = { submit: vi.fn(async () => ({})), send: vi.fn(async () => ({})) };
    const reply = createReplySender(client as never, "m1");
    await reply("first");
    await reply("second");
    await reply("   ");
    expect(client.submit).toHaveBeenCalledWith("m1", "first");
    expect(client.send).toHaveBeenCalledWith({ inReplyTo: "m1", parts: [{ kind: "text", text: "second" }] });
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("falls back to a threaded DM when the DM is already closed", async () => {
    const client = {
      submit: vi.fn(async () => {
        throw new SwarmDMError("closed", 409, "wrong_state");
      }),
      send: vi.fn(async () => ({})),
    };
    await createReplySender(client as never, "m1")("answer");
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it("rethrows other errors", async () => {
    const client = {
      submit: vi.fn(async () => {
        throw new SwarmDMError("down", 503);
      }),
      send: vi.fn(),
    };
    await expect(createReplySender(client as never, "m1")("answer")).rejects.toThrow("down");
  });
});

describe("state file", () => {
  it("persists cursor, seen ids, parked DMs and requests", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "swarmdm-state-"));
    const file = StateFile.pathFor(dir, "default");
    const s = new StateFile(file);
    s.setCursor("m5");
    s.markSeen("m5");
    s.park("ada", "m4");
    s.rememberRequest("ben", "fr_9");
    const again = new StateFile(file);
    expect(again.cursor).toBe("m5");
    expect(again.hasSeen("m5")).toBe(true);
    expect(again.parkedSenders()).toEqual(["ada"]);
    expect(again.takeParked("ada")).toEqual(["m4"]);
    expect(again.pendingRequests()).toEqual([{ sender: "ben", requestId: "fr_9" }]);
    expect(new StateFile(file).parkedSenders()).toEqual([]);
  });
});

describe("setup", () => {
  it("writes root config for the default account and nests named ones", () => {
    const cfg = applySwarmAccountConfig({ cfg: {} as never, input: { token: " bt_a ", dmPolicy: "pairing", junk: 1 } });
    expect(cfg.channels).toEqual({ swarmdm: { token: "bt_a", dmPolicy: "pairing" } });
    const two = applySwarmAccountConfig({ cfg, accountId: "work", input: { token: "bt_w" } });
    expect((two.channels as Record<string, unknown>).swarmdm).toEqual({
      token: "bt_a",
      dmPolicy: "pairing",
      accounts: { work: { token: "bt_w" } },
    });
  });
});

describe("peer safety", async () => {
  const { filterReplyPayload } = await import("../src/inbound.js");
  const { swarmOwners } = await import("../src/access.js");

  it("never forwards host errors or notices to a peer", () => {
    expect(filterReplyPayload({ text: "4" })).not.toBeNull();
    for (const flag of ["isError", "isStatusNotice", "isFallbackNotice", "isCompactionNotice", "isCommentary", "isReasoning"]) {
      expect(filterReplyPayload({ text: "⚠️ Couldn't sign in", [flag]: true } as never)).toBeNull();
    }
  });

  it("spots SwarmDM peers among command owners", () => {
    expect(swarmOwners({ commands: { ownerAllowFrom: ["telegram:1", "swarmdm:skilltest_ben"] } })).toEqual(["swarmdm:skilltest_ben"]);
    expect(swarmOwners({})).toEqual([]);
  });
});
