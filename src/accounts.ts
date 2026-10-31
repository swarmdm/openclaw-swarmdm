import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_API_BASE } from "./client.js";

export const CHANNEL_ID = "swarmdm" as const;
export const DEFAULT_ACCOUNT_ID = "default";
/** Where the swarmdm skill keeps its token; reused so the owner sets it up once. */
export const SKILL_TOKEN_FILE = path.join(homedir(), ".swarmdm", "token");
export const DEFAULT_MAX_TURNS_PER_PEER_PER_HOUR = 20;

export type SwarmDmPolicy = "pairing" | "open" | "disabled";

export type SwarmAccountConfig = {
  enabled?: boolean;
  name?: string;
  token?: string;
  tokenFile?: string;
  apiBase?: string;
  dmPolicy?: SwarmDmPolicy;
  maxTurnsPerPeerPerHour?: number;
};

export type SwarmChannelConfig = SwarmAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, SwarmAccountConfig>;
};

export type ResolvedSwarmAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  token: string;
  tokenSource: "config" | "tokenFile" | "env" | "skill" | "none";
  apiBase: string;
  dmPolicy: SwarmDmPolicy;
  maxTurnsPerPeerPerHour: number;
  config: SwarmAccountConfig;
};

export function channelSection(cfg: OpenClawConfig | undefined): SwarmChannelConfig | undefined {
  return (cfg?.channels as Record<string, SwarmChannelConfig | undefined> | undefined)?.[CHANNEL_ID];
}

export function listAccountIds(cfg: OpenClawConfig): string[] {
  const section = channelSection(cfg);
  if (!section) return [];
  const named = Object.keys(section.accounts ?? {});
  return named.length > 0 ? named : [DEFAULT_ACCOUNT_ID];
}

export function defaultAccountId(cfg: OpenClawConfig): string {
  const section = channelSection(cfg);
  const ids = listAccountIds(cfg);
  if (section?.defaultAccount && ids.includes(section.defaultAccount)) return section.defaultAccount;
  return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : (ids[0] ?? DEFAULT_ACCOUNT_ID);
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

function readTokenFile(p: string): string {
  try {
    const file = expandHome(p);
    return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  } catch {
    return "";
  }
}

/** Token lookup order: config `token` → `tokenFile` → $SWARMDM_TOKEN → the skill's ~/.swarmdm/token.
 * The env and skill fallbacks apply to the default account only. */
export function resolveToken(
  merged: SwarmAccountConfig,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): { token: string; source: ResolvedSwarmAccount["tokenSource"] } {
  if (merged.token?.trim()) return { token: merged.token.trim(), source: "config" };
  if (merged.tokenFile?.trim()) {
    const t = readTokenFile(merged.tokenFile.trim());
    return t ? { token: t, source: "tokenFile" } : { token: "", source: "none" };
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) return { token: "", source: "none" };
  const fromEnv = env.SWARMDM_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  const fromSkill = readTokenFile(SKILL_TOKEN_FILE);
  return fromSkill ? { token: fromSkill, source: "skill" } : { token: "", source: "none" };
}

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSwarmAccount {
  const section = channelSection(cfg) ?? {};
  const id = accountId?.trim() || defaultAccountId(cfg);
  const { accounts: _accounts, defaultAccount: _default, ...root } = section;
  const own = section.accounts?.[id];
  const merged: SwarmAccountConfig = { ...root, ...(own ?? {}) };
  const { token, source } = resolveToken(merged, id, env);
  const enabled = section.enabled !== false && merged.enabled !== false;
  const dmPolicy: SwarmDmPolicy =
    merged.dmPolicy === "open" || merged.dmPolicy === "disabled" ? merged.dmPolicy : "pairing";
  return {
    accountId: id,
    enabled,
    configured: Boolean(token),
    name: merged.name?.trim() || undefined,
    token,
    tokenSource: source,
    apiBase: (merged.apiBase?.trim() || DEFAULT_API_BASE).replace(/\/+$/, ""),
    dmPolicy,
    maxTurnsPerPeerPerHour: merged.maxTurnsPerPeerPerHour ?? DEFAULT_MAX_TURNS_PER_PEER_PER_HOUR,
    config: merged,
  };
}

/** Status-safe view: never includes the token. */
export function inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const a = resolveAccount(cfg, accountId);
  return {
    accountId: a.accountId,
    enabled: a.enabled,
    configured: a.configured,
    tokenStatus: a.configured ? "available" : "missing",
    tokenSource: a.tokenSource,
    apiBase: a.apiBase,
    dmPolicy: a.dmPolicy,
  };
}

/** Normalize a target or allowlist entry to a bare SwarmDM bot_id. */
export function normalizeBotId(raw: string): string {
  return raw
    .trim()
    .replace(/^(swarmdm|swarm):/i, "")
    .replace(/^(dm|user|bot):/i, "")
    .trim();
}
