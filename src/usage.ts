/**
 * Picks the subscription windows worth showing out of oh-my-pi's normalized
 * usage reports.
 *
 * omp already fetches Claude and Codex plan usage through its own provider
 * integrations (`@oh-my-pi/pi-ai` `usage/claude.ts`, `usage/openai-codex.ts`)
 * and keeps the result fresh from response rate-limit headers. This module
 * only chooses the active account's report and reduces it to the rolling
 * windows (5h, 7d, …) the footer shows. Pure: no I/O, no omp runtime.
 */
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";

export type Severity = "ok" | "warning" | "critical";

export interface WindowSummary {
  /** Short window label, e.g. "5h" or "7d", with the model tier appended when scoped. */
  label: string;
  /** Percent of the window used, 0..100+ (over 100 means overage). */
  usedPercent: number;
  /** Epoch ms the window resets, when the provider reports it. */
  resetsAt?: number;
  /** Window length in ms, used for ordering. */
  durationMs: number;
  severity: Severity;
}

export interface ProviderSummary {
  provider: string;
  /** Display name, e.g. "Claude". */
  name: string;
  /** Plan name when the provider reports one (Codex: "plus", "pro"). */
  plan?: string;
  /** Codex saved rate-limit resets the account can redeem. */
  savedResets?: number;
  windows: WindowSummary[];
}

/** Minimal slice of omp's `OAuthAccountIdentity`. */
export interface AccountIdentity {
  accountId?: string;
  email?: string;
}

export const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "Codex",
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Same thresholds as omp's native `usage` status-line segment. */
export function severityFor(usedPercent: number, exhausted = false): Severity {
  if (exhausted || usedPercent >= 80) return "critical";
  if (usedPercent >= 50) return "warning";
  return "ok";
}

/**
 * Pick the report for the account this session is using. With several
 * accounts logged in for one provider, omp returns a report per account;
 * the one matching the active identity wins, otherwise the first.
 */
export function selectReport(
  reports: readonly UsageReport[],
  provider: string,
  identity?: AccountIdentity,
): UsageReport | undefined {
  const candidates = reports.filter((r) => r.provider === provider);
  if (candidates.length <= 1 || !identity) return candidates[0];
  const match = candidates.find((r) => {
    const meta = r.metadata ?? {};
    return (
      (identity.accountId !== undefined && meta.accountId === identity.accountId) ||
      (identity.email !== undefined && meta.email === identity.email)
    );
  });
  return match ?? candidates[0];
}

/** Used fraction from whichever amount fields the provider filled in (mirrors pi-ai's resolveUsedFraction). */
export function usedFraction(limit: UsageLimit): number | undefined {
  const a = limit.amount;
  if (a.usedFraction !== undefined) return a.usedFraction;
  if (a.used !== undefined && a.limit !== undefined && a.limit > 0) return a.used / a.limit;
  if (a.unit === "percent" && a.used !== undefined) return a.used / 100;
  if (a.remainingFraction !== undefined) return Math.max(0, 1 - a.remainingFraction);
  return undefined;
}

const WINDOW_ID = /^(\d+)([hd])$/;

/** Window length in ms from `durationMs`, else from an id like "5h" / "7d". */
function windowDuration(limit: UsageLimit): number | undefined {
  const w = limit.window;
  if (!w) return undefined;
  if (w.durationMs !== undefined && w.durationMs > 0) return w.durationMs;
  const m = WINDOW_ID.exec(w.id);
  if (!m?.[1]) return undefined;
  return Number(m[1]) * (m[2] === "d" ? DAY_MS : HOUR_MS);
}

/** "5h", "7d", "1d"; falls back to the provider's window id. */
export function windowLabel(durationMs: number, fallback: string): string {
  if (durationMs % DAY_MS === 0) return `${durationMs / DAY_MS}d`;
  if (durationMs % HOUR_MS === 0) return `${durationMs / HOUR_MS}h`;
  return fallback;
}

export interface SummarizeOptions {
  /** Include per-model tier windows (e.g. Claude's Fable weekly cap). */
  modelLimits?: boolean;
}

/**
 * Reduce a report to its rolling time windows, shortest first. Limits
 * without a time window (Claude "extra usage" spend) are skipped, as are
 * model-tier windows unless asked for.
 */
export function summarize(report: UsageReport, options: SummarizeOptions = {}): ProviderSummary {
  const windows: WindowSummary[] = [];
  for (const limit of report.limits) {
    const tier = limit.scope.tier;
    if (tier && !options.modelLimits) continue;
    const durationMs = windowDuration(limit);
    const fraction = usedFraction(limit);
    if (durationMs === undefined || fraction === undefined) continue;
    const usedPercent = fraction * 100;
    const base = windowLabel(durationMs, limit.window?.id ?? limit.id);
    windows.push({
      label: tier ? `${base} ${tier}` : base,
      usedPercent,
      resetsAt: limit.window?.resetsAt,
      durationMs,
      severity: severityFor(usedPercent, limit.status === "exhausted"),
    });
  }
  // Shortest window first; shared windows ahead of tier windows of the same length.
  windows.sort((a, b) => a.durationMs - b.durationMs || a.label.length - b.label.length);
  const plan = report.metadata?.planType;
  const savedResets = report.resetCredits?.availableCount;
  return {
    provider: report.provider,
    name: PROVIDER_NAMES[report.provider] ?? report.provider,
    ...(typeof plan === "string" && plan ? { plan } : {}),
    ...(savedResets ? { savedResets } : {}),
    windows,
  };
}
