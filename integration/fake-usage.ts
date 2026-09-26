/**
 * Test-only omp extension: swaps omp's Claude and Codex usage fetchers for
 * canned ones, so the integration test drives the plugin through omp's real
 * AuthStorage pipeline (request collection, caching, dedupe) without OAuth
 * logins or network access.
 *
 * Loaded with `-e` and installed on session_start. Handlers run in load
 * order, so when the plugin also comes from `-e` it must come after this.
 */
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

function limit(provider: string, id: string, windowMs: number, used: number, resetsInMs: number) {
  const windowId = windowMs >= DAY ? `${windowMs / DAY}d` : `${windowMs / HOUR}h`;
  return {
    id: `${provider}:${id}`,
    label: windowId,
    scope: { provider, windowId, shared: true },
    // Half a minute of slack so countdowns read as whole minutes when the test checks them.
    window: {
      id: windowId,
      label: windowId,
      durationMs: windowMs,
      resetsAt: Date.now() + resetsInMs + 30_000,
    },
    amount: { used, limit: 100, usedFraction: used / 100, unit: "percent" as const },
    status: used >= 80 ? ("warning" as const) : ("ok" as const),
  };
}

function fake(provider: string, build: () => UsageReport): UsageProvider {
  return {
    id: provider,
    supports: () => true,
    fetchUsage: async () => build(),
  };
}

export const FAKE_PROVIDERS: UsageProvider[] = [
  fake("anthropic", () => ({
    provider: "anthropic",
    fetchedAt: Date.now(),
    limits: [
      limit("anthropic", "5h", 5 * HOUR, 42, 2 * HOUR + 13 * MIN),
      limit("anthropic", "7d", 7 * DAY, 17, 3 * DAY + 4 * HOUR),
    ],
    metadata: { email: "claude@example.com" },
  })),
  fake("openai-codex", () => ({
    provider: "openai-codex",
    fetchedAt: Date.now(),
    limits: [
      limit("openai-codex", "primary", 5 * HOUR, 81, 40 * MIN),
      limit("openai-codex", "secondary", 7 * DAY, 23, 6 * DAY),
    ],
    resetCredits: { availableCount: 1 },
    metadata: { planType: "plus", accountId: "codex-account" },
  })),
];

interface RuntimeUsageHost {
  usage?: { setProvider(provider: string, impl: UsageProvider, apiKey?: string): void };
  setRuntimeUsageProvider?(provider: string, impl: UsageProvider, apiKey?: string): void;
}

export default function fakeUsage(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const auth = ctx.modelRegistry.authStorage as unknown as RuntimeUsageHost;
    for (const impl of FAKE_PROVIDERS) {
      // The key only has to exist: it makes AuthStorage issue a usage request
      // for a provider that has no stored login.
      if (auth.usage) auth.usage.setProvider(impl.id, impl, "fake-key");
      else auth.setRuntimeUsageProvider?.(impl.id, impl, "fake-key");
    }
  });
}
