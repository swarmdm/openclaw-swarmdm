import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Per-account poller state, kept small and rewritten atomically:
 * - `cursor`: newest inbox id handled; long polls ask only for newer DMs
 * - `seen`: DM ids already dispatched or settled (dedupe across restarts)
 * - `parked`: DMs from senders waiting for pairing approval, by sender
 * - `requests`: open SwarmDM friend requests we turned into pairing requests */
export type PollState = {
  cursor: string | null;
  seen: string[];
  parked: Record<string, string[]>;
  requests: Record<string, { requestId: string; at: number }>;
};

const MAX_SEEN = 2000;
const MAX_PARKED_PER_SENDER = 5;

export class StateFile {
  private data: PollState;

  constructor(private readonly file: string) {
    this.data = StateFile.load(file);
  }

  static pathFor(stateDir: string, accountId: string): string {
    const safe = accountId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(stateDir, "plugins", "swarmdm", `${safe}.json`);
  }

  private static load(file: string): PollState {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PollState>;
      return {
        cursor: typeof raw.cursor === "string" ? raw.cursor : null,
        seen: Array.isArray(raw.seen) ? raw.seen.filter((x) => typeof x === "string") : [],
        parked: raw.parked && typeof raw.parked === "object" ? raw.parked : {},
        requests: raw.requests && typeof raw.requests === "object" ? raw.requests : {},
      };
    } catch {
      return { cursor: null, seen: [], parked: {}, requests: {} };
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get cursor(): string | null {
    return this.data.cursor;
  }

  setCursor(id: string): void {
    if (this.data.cursor === id) return;
    this.data.cursor = id;
    this.save();
  }

  hasSeen(id: string): boolean {
    return this.data.seen.includes(id);
  }

  markSeen(id: string): void {
    if (this.hasSeen(id)) return;
    this.data.seen.push(id);
    if (this.data.seen.length > MAX_SEEN) this.data.seen.splice(0, this.data.seen.length - MAX_SEEN);
    this.save();
  }

  park(sender: string, messageId: string): void {
    const list = this.data.parked[sender] ?? [];
    if (!list.includes(messageId)) list.push(messageId);
    this.data.parked[sender] = list.slice(-MAX_PARKED_PER_SENDER);
    this.save();
  }

  takeParked(sender: string): string[] {
    const list = this.data.parked[sender] ?? [];
    delete this.data.parked[sender];
    this.save();
    return list;
  }

  parkedSenders(): string[] {
    return Object.keys(this.data.parked);
  }

  rememberRequest(sender: string, requestId: string): void {
    this.data.requests[sender] = { requestId, at: Date.now() };
    this.save();
  }

  forgetRequest(sender: string): void {
    if (!(sender in this.data.requests)) return;
    delete this.data.requests[sender];
    this.save();
  }

  pendingRequests(): Array<{ sender: string; requestId: string }> {
    return Object.entries(this.data.requests).map(([sender, r]) => ({ sender, requestId: r.requestId }));
  }
}
