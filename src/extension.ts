/**
 * oh-my-pi extension: Claude and Codex subscription usage in the footer.
 *
 * Usage comes from omp's own AuthStorage (see `source.ts`), so there is no
 * second OAuth client, no token reading and no extra polling of Anthropic or
 * OpenAI: omp's usage cache decides when to hit the network (about every
 * five minutes) and refreshes its snapshot from the rate-limit headers of
 * every Claude and Codex response in between. This extension re-reads that
 * cache on a timer and after each turn, and redraws the countdowns.
 *
 * Referenced from `package.json#omp.extensions`.
 */
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUiComponent,
} from "@oh-my-pi/pi-coding-agent";
import { formatDetails, formatLine, type Stylist } from "./format.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { usageSource } from "./source.ts";
import { type ProviderSummary, selectReport, summarize } from "./usage.ts";

export const STATUS_KEY = "sub-usage";
/** Redraw often enough that minute-precision countdowns never lag by more than half a minute. */
const TICK_MS = 30_000;

type Theme = ExtensionContext["ui"]["theme"];

function themeStylist(theme: Theme): Stylist {
  return {
    name: (t) => theme.fg("accent", t),
    percent: (t, severity) =>
      theme.fg(
        severity === "critical" ? "error" : severity === "warning" ? "warning" : "success",
        t,
      ),
    muted: (t) => theme.fg("muted", t),
  };
}

function textWidth(text: string): number {
  return typeof Bun !== "undefined" ? Bun.stringWidth(text) : text.length;
}

/** Cut plain text to fit `width` columns, marking the cut with an ellipsis. */
export function clip(text: string, width: number): string {
  if (textWidth(text) <= width) return text;
  if (width <= 0) return "";
  let out = "";
  for (const ch of text) {
    if (textWidth(`${out}${ch}…`) > width) break;
    out += ch;
  }
  return `${out}…`;
}

/** Reduce reports to the configured providers, in configured order. */
export function buildSummaries(
  reports: readonly UsageReport[],
  settings: Pick<Settings, "providers" | "modelLimits">,
  identity: (provider: string) => { accountId?: string; email?: string } | undefined,
): ProviderSummary[] {
  const out: ProviderSummary[] = [];
  for (const provider of settings.providers) {
    const report = selectReport(reports, provider, identity(provider));
    if (report) out.push(summarize(report, { modelLimits: settings.modelLimits }));
  }
  return out;
}

export default function subUsage(pi: ExtensionAPI): void {
  let settings: Settings | undefined;
  let summaries: ProviderSummary[] = [];
  let inFlight: Promise<void> | undefined;
  let requestRender: (() => void) | undefined;
  let widgetShown = false;

  const active = (ctx: ExtensionContext) => ctx.hasUI && settings !== undefined;

  function render(ctx: ExtensionContext): void {
    if (!active(ctx) || !settings) return;
    const now = Date.now();
    if (settings.display === "widget" && ctx.mode === "tui") {
      if (!summaries.some((s) => s.windows.length > 0)) {
        if (widgetShown) ctx.ui.setWidget(STATUS_KEY, undefined);
        widgetShown = false;
        return;
      }
      if (!widgetShown) {
        ctx.ui.setWidget(STATUS_KEY, (tui, theme) => widget(tui, theme), {
          placement: "belowEditor",
        });
        widgetShown = true;
      }
      requestRender?.();
      return;
    }
    const line = formatLine(summaries, { now, windowSep: ctx.ui.theme.sep.dot });
    ctx.ui.setStatus(STATUS_KEY, line || undefined);
  }

  function widget(tui: { requestRender(): void }, theme: Theme): ExtensionUiComponent {
    requestRender = () => tui.requestRender();
    const style = themeStylist(theme);
    return {
      render(width: number): string[] {
        const now = Date.now();
        const windowSep = theme.sep.dot;
        const plain = formatLine(summaries, { now, windowSep });
        if (plain === "") return [];
        if (textWidth(plain) <= width) return [formatLine(summaries, { now, windowSep, style })];
        // Too narrow: drop the countdowns rather than cut a provider off.
        const bare = summaries.map((s) => ({
          ...s,
          windows: s.windows.map(({ resetsAt: _, ...w }) => w),
        }));
        const compact = { now, windowSep: " ", providerSep: " | " };
        const plainCompact = formatLine(bare, compact);
        if (textWidth(plainCompact) <= width) return [formatLine(bare, { ...compact, style })];
        // Still too wide: plain text, clipped. Rows must never exceed the terminal width.
        return [clip(plainCompact, width)];
      },
      invalidate() {},
      dispose() {
        requestRender = undefined;
      },
    };
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (!active(ctx) || !settings) return;
    if (inFlight) return inFlight;
    const source = usageSource(ctx.modelRegistry);
    if (!source) return;
    const current = settings;
    inFlight = (async () => {
      try {
        const reports = await source.reports(AbortSignal.timeout(20_000));
        const sessionId = ctx.sessionManager.getSessionId();
        summaries = buildSummaries(reports, current, (p) => source.identity(p, sessionId));
      } catch (err) {
        // Keep the last good summaries; omp's cache retries on its own backoff.
        pi.logger.debug("sub-usage: usage fetch failed", { err: String(err) });
      } finally {
        inFlight = undefined;
      }
      render(ctx);
    })();
    return inFlight;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    settings = loadSettings({ cwd: ctx.cwd, agentDir: pi.pi.getAgentDir?.() });
    ctx.setInterval(() => void refresh(ctx), settings.refreshSeconds * 1000);
    ctx.setInterval(() => render(ctx), TICK_MS);
    // Not awaited: session start must not wait on a network round trip.
    void refresh(ctx);
  });

  // Every Claude/Codex response feeds omp's usage cache from its rate-limit
  // headers, so re-reading after a turn picks up the new numbers for free.
  pi.on("turn_end", async (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (widgetShown) ctx.ui.setWidget(STATUS_KEY, undefined);
    widgetShown = false;
  });

  pi.registerCommand("sub-usage", {
    description: "Claude and Codex subscription usage; `/sub-usage refresh` re-fetches now",
    getArgumentCompletions: (prefix) =>
      "refresh".startsWith(prefix)
        ? [
            {
              value: "refresh",
              label: "refresh",
              description: "Discard cached usage and fetch now",
            },
          ]
        : null,
    handler: async (args, ctx) => {
      settings ??= loadSettings({ cwd: ctx.cwd, agentDir: pi.pi.getAgentDir?.() });
      const source = usageSource(ctx.modelRegistry);
      if (!source) {
        ctx.ui.notify("This omp build exposes no usage API to extensions.", "warning");
        return;
      }
      if (args.trim() === "refresh") {
        await Promise.all(settings.providers.map((p) => source.invalidate(p)));
      }
      const reports = await source.reports();
      const sessionId = ctx.sessionManager.getSessionId();
      const detailed = buildSummaries(reports, { ...settings, modelLimits: true }, (p) =>
        source.identity(p, sessionId),
      );
      // The footer keeps its own model-limit setting; refresh it from the same reports.
      summaries = buildSummaries(reports, settings, (p) => source.identity(p, sessionId));
      render(ctx);
      ctx.ui.notify(formatDetails(detailed, Date.now()), "info");
    },
  });
}
