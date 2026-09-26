/**
 * Usage reports in the exact shape omp's Claude and Codex usage providers
 * produce (captured from a live omp session, identities replaced).
 */
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";

export const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function pct(
  id: string,
  provider: string,
  windowId: string,
  durationMs: number,
  used: number,
  resetsAt: number,
  extra: Partial<UsageLimit["scope"]> = {},
): UsageLimit {
  return {
    id,
    label: id,
    scope: { provider, windowId, ...(extra.tier ? {} : { shared: true }), ...extra },
    window: { id: windowId, label: windowId, durationMs, resetsAt },
    amount: {
      used,
      limit: 100,
      remaining: 100 - used,
      usedFraction: used / 100,
      remainingFraction: 1 - used / 100,
      unit: "percent",
    },
    status: used >= 100 ? "exhausted" : used >= 80 ? "warning" : "ok",
  };
}

export function claudeReport(
  opts: { fiveHour?: number; weekly?: number; email?: string } = {},
): UsageReport {
  return {
    provider: "anthropic",
    fetchedAt: NOW,
    limits: [
      pct(
        "anthropic:5h",
        "anthropic",
        "5h",
        5 * HOUR,
        opts.fiveHour ?? 9,
        NOW + 2 * HOUR + 53 * 60_000,
      ),
      pct("anthropic:7d", "anthropic", "7d", 7 * DAY, opts.weekly ?? 2, NOW + 2 * DAY + 6 * HOUR),
      pct("anthropic:7d:fable", "anthropic", "7d", 7 * DAY, 0, NOW + 2 * DAY + 6 * HOUR, {
        tier: "fable",
      }),
      {
        id: "anthropic:extra",
        label: "Extra usage",
        scope: { provider: "anthropic", windowId: "extra" },
        amount: { used: 3.2, limit: 50, unit: "usd" },
      },
    ],
    metadata: { email: opts.email ?? "me@example.com", accountId: "acct-claude" },
  };
}

export function codexReport(
  opts: { fiveHour?: number; weekly?: number; accountId?: string } = {},
): UsageReport {
  const limits: UsageLimit[] = [];
  if (opts.fiveHour !== undefined) {
    limits.push(
      pct("openai-codex:primary", "openai-codex", "5h", 5 * HOUR, opts.fiveHour, NOW + 40 * 60_000),
    );
  }
  limits.push(
    pct(
      opts.fiveHour !== undefined ? "openai-codex:secondary" : "openai-codex:primary",
      "openai-codex",
      "7d",
      7 * DAY,
      opts.weekly ?? 0,
      NOW + 6 * DAY + 23 * HOUR,
    ),
  );
  return {
    provider: "openai-codex",
    fetchedAt: NOW,
    limits,
    resetCredits: { availableCount: 2 },
    metadata: { planType: "plus", accountId: opts.accountId ?? "acct-codex" },
  };
}
