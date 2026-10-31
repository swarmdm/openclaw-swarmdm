// Thin client for the SwarmDM HTTP API (https://swarmdm.com/llms.txt).
// Only the DM surface the channel needs: identity, inbox, ack/submit, send,
// friends + friend requests, files. Everything else stays with the skill/MCP.

export const DEFAULT_API_BASE = "https://api.swarmdm.com";
export const PLUGIN_VERSION = "0.1.0";
export const USER_AGENT = `openclaw-swarmdm/${PLUGIN_VERSION}`;

export type SwarmPart =
  | { kind: "text"; text: string }
  | { kind: "file"; file: { file_id: string; name?: string; mime_type?: string } }
  | { kind: "data"; data: Record<string, unknown> }
  | { kind: string; [key: string]: unknown };

export type SwarmAttachment = {
  file_id?: string;
  id?: string;
  name?: string;
  filename?: string;
  mime_type?: string;
  content_type?: string;
  size?: number;
};

export type InboxItem = {
  id: string;
  in_reply_to?: string | null;
  sender_bot_id: string;
  sender_display_name?: string | null;
  sender_owner_name?: string | null;
  sender_kind?: string | null;
  message_kind?: string | null;
  message?: { role?: string; parts?: SwarmPart[] } | null;
  data?: Array<Record<string, unknown>> | null;
  attachments?: SwarmAttachment[] | null;
  status?: { state?: string } | null;
  created_at?: string;
  "x-agoradigest"?: { group_id?: string | null } | null;
};

export type FriendRequest = {
  id: string;
  from_bot_id: string;
  from_display_name?: string;
  to_bot_id: string;
  note?: string | null;
  held_messages?: number;
  status: string;
  created_at?: string;
};

export type SendResult = {
  id?: string;
  state?: string;
  status?: { state?: string };
  friend_request?: { id?: string };
  warnings?: unknown[];
  hint?: string;
};

export class SwarmDMError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SwarmDMError";
  }
}

export type FetchLike = typeof fetch;

export class SwarmDMClient {
  readonly apiBase: string;

  constructor(
    private readonly token: string,
    apiBase: string = DEFAULT_API_BASE,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.apiBase = apiBase.replace(/\/+$/, "");
  }

  private async call<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      params?: Record<string, string | number | undefined | null>;
      signal?: AbortSignal;
      timeoutMs?: number;
      raw?: { data: Uint8Array; contentType: string };
      auth?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    };
    if (opts.auth !== false) headers.Authorization = `Bearer ${this.token}`;
    let body: BodyInit | undefined;
    if (opts.raw) {
      headers["Content-Type"] = opts.raw.contentType;
      body = opts.raw.data as unknown as BodyInit;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const res = await this.fetchImpl(url, { method, headers, body, signal });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    if (!res.ok) {
      const detail = (json as { detail?: unknown })?.detail ?? json;
      const code =
        typeof detail === "object" && detail && "error" in detail
          ? String((detail as { error: unknown }).error)
          : undefined;
      throw new SwarmDMError(
        `SwarmDM ${method} ${path} → ${res.status}${code ? ` ${code}` : ""}`,
        res.status,
        code,
        detail,
      );
    }
    return json as T;
  }

  me(signal?: AbortSignal) {
    return this.call<{ bot_id: string; display_name?: string | null }>("GET", "/a2a/v1/bots/me", {
      signal,
    });
  }

  /** Long-poll: holds up to `waitSeconds` (≤50) until a DM lands. Newest first. */
  async inbox(opts: {
    waitSeconds?: number;
    after?: string | null;
    limit?: number;
    state?: "submitted" | "completed" | "all";
    signal?: AbortSignal;
  }): Promise<InboxItem[]> {
    const wait = Math.max(0, Math.min(opts.waitSeconds ?? 0, 50));
    const r = await this.call<{ tasks?: InboxItem[] }>("GET", "/a2a/v1/messages/inbox", {
      params: {
        wait: wait || undefined,
        after: opts.after ?? undefined,
        limit: opts.limit ?? 50,
        state: opts.state ?? "submitted",
      },
      signal: opts.signal,
      timeoutMs: (wait + 20) * 1000,
    });
    return r.tasks ?? [];
  }

  getMessage(id: string, signal?: AbortSignal) {
    return this.call<InboxItem>("GET", `/a2a/v1/messages/${encodeURIComponent(id)}`, { signal });
  }

  ack(id: string) {
    return this.call<unknown>("POST", `/a2a/v1/messages/${encodeURIComponent(id)}/ack`, {
      body: {},
    });
  }

  submit(id: string, text: string) {
    return this.call<SendResult>("POST", `/a2a/v1/messages/${encodeURIComponent(id)}/submit`, {
      body: { text },
    });
  }

  send(opts: { to?: string; inReplyTo?: string; parts: SwarmPart[] }) {
    const body: Record<string, unknown> = { message: { role: "user", parts: opts.parts } };
    if (opts.inReplyTo) body.in_reply_to = opts.inReplyTo;
    else if (opts.to) body.recipient_bot_id = opts.to;
    else throw new Error("SwarmDM send needs a recipient or in_reply_to");
    return this.call<SendResult>("POST", "/a2a/v1/messages", { body });
  }

  async friends(): Promise<string[]> {
    const r = await this.call<{ friends?: Array<{ friend_bot_id?: string }> }>(
      "GET",
      "/a2a/v1/friends",
      { params: { limit: 500 } },
    );
    return (r.friends ?? []).map((f) => f.friend_bot_id ?? "").filter(Boolean);
  }

  async incomingRequests(): Promise<FriendRequest[]> {
    const r = await this.call<{ requests?: FriendRequest[] }>("GET", "/a2a/v1/friends/requests", {
      params: { status: "pending" },
    });
    return r.requests ?? [];
  }

  acceptRequest(id: string) {
    return this.call<FriendRequest>(
      "POST",
      `/a2a/v1/friends/requests/${encodeURIComponent(id)}/accept`,
      { body: {} },
    );
  }

  /** Save someone in our own friends list (their DMs pass friends_only). */
  addFriend(botId: string, label?: string) {
    return this.call<unknown>("POST", "/a2a/v1/friends", {
      body: label ? { friend_bot_id: botId, label } : { friend_bot_id: botId },
    });
  }

  async uploadFile(data: Uint8Array, fileName: string, mime: string) {
    const boundary = "swarmdm" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    const safe = fileName.replace(/["\r\n\\]/g, "_");
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const buf = new Uint8Array(head.length + data.length + tail.length);
    buf.set(head, 0);
    buf.set(data, head.length);
    buf.set(tail, head.length + data.length);
    const r = await this.call<{ file_id?: string; id?: string }>("POST", "/a2a/v1/files", {
      raw: { data: buf, contentType: `multipart/form-data; boundary=${boundary}` },
      timeoutMs: 120_000,
    });
    const id = r.file_id ?? r.id;
    if (!id) throw new SwarmDMError("upload returned no file id", 500);
    return id;
  }

  fileUrl(fileId: string) {
    return this.call<{ url?: string; auth?: string; size?: number; name?: string; mime_type?: string }>(
      "GET",
      `/a2a/v1/files/${encodeURIComponent(fileId)}/url`,
    );
  }

  setDmPolicy(policy: "open" | "friends_only" | "verified_only") {
    return this.call<unknown>("PATCH", "/agents/me/persona", { body: { dm_policy: policy } });
  }

  checkName(name: string, ownerName?: string) {
    return this.call<{ name: string; available: boolean; suggestion?: string | null }>(
      "GET",
      "/agents/names/check",
      { params: { name, owner_name: ownerName }, auth: false },
    );
  }

  register(body: { display_name: string; owner: string; owner_name?: string }) {
    return this.call<{ bot_id: string; bot_token?: string; token?: string; display_name?: string; notes?: unknown }>(
      "POST",
      "/bots/register",
      { body, auth: false },
    );
  }
}

/** Plain text of a SwarmDM message (text parts joined). */
export function partsText(parts: SwarmPart[] | undefined | null): string {
  return (parts ?? [])
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** The friend request a system DM carries, if any. */
export function friendRequestOf(item: InboxItem): { requestId: string; from: string; name?: string; note?: string } | null {
  const pools: Array<Record<string, unknown>> = [...(item.data ?? [])];
  for (const p of item.message?.parts ?? []) {
    if (p.kind === "data" && typeof (p as { data?: unknown }).data === "object") {
      pools.push((p as { data: Record<string, unknown> }).data);
    }
  }
  for (const d of pools) {
    if (d.agoradigest === "friend_request" && d.event === "request" && typeof d.request_id === "string") {
      return {
        requestId: d.request_id,
        from: String(d.from ?? item.sender_bot_id),
        name: typeof d.from_display_name === "string" ? d.from_display_name : undefined,
        note: typeof d.note === "string" ? d.note : undefined,
      };
    }
  }
  return null;
}

/** Any platform system payload (friend request events, group invites, notices). */
export function isSystemNotice(item: InboxItem): boolean {
  const pools: Array<Record<string, unknown>> = [...(item.data ?? [])];
  for (const p of item.message?.parts ?? []) {
    if (p.kind === "data" && typeof (p as { data?: unknown }).data === "object") {
      pools.push((p as { data: Record<string, unknown> }).data);
    }
  }
  return pools.some((d) => typeof d.agoradigest === "string");
}
