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
/** Upper bound on one read of omp's usage cache, network fetch included. */
const FETCH_TIMEOUT_MS = 20_000;
/**
 * Between windows in the footer status. omp joins every extension's status
 * with the theme's dot separator, so using that dot here too would make a
 * neighbouring status read as another window.
 */
const STATUS_WINDOW_SEP = " ";

type Theme = ExtensionContext["ui"]["theme"];

function themeStylist(theme: Theme): Stylist {
  return {
    name: (t) => theme.fg("accent", t),
    // Same colours as omp's native `usage` segment.
    percent: (t, severity) =>
      theme.fg(severity === "critical" ? "error" : severity === "warning" ? "warning" : "muted", t),
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
  /** The plain line last pushed to the host; unchanged lines are not sent again. */
  let lastLine: string | undefined;

  const active = (ctx: ExtensionContext) => ctx.hasUI && settings !== undefined;

  function render(ctx: ExtensionContext): void {
    if (!active(ctx) || !settings) return;
    const widgetMode = settings.display === "widget" && ctx.mode === "tui";
    const line = formatLine(summaries, {
      now: Date.now(),
      windowSep: widgetMode ? ctx.ui.theme.sep.dot : STATUS_WINDOW_SEP,
    });
    if (line === lastLine) return;
    lastLine = line;
    if (!widgetMode) {
      ctx.ui.setStatus(STATUS_KEY, line || undefined);
      return;
    }
    if (line === "") {
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
  }

  function widget(tui: { requestRender(): void }, theme: Theme): ExtensionUiComponent {
    requestRender = () => tui.requestRender();
    const style = themeStylist(theme);
    // omp renders every frame, keystrokes included; rebuild only when the
    // line or the width changes.
    let cached: { width: number; line: string | undefined; rows: string[] } | undefined;
    const rows = (width: number): string[] => {
      const now = Date.now();
      const full = { now, windowSep: theme.sep.dot };
      const plain = formatLine(summaries, full);
      if (plain === "") return [];
      if (textWidth(plain) <= width) return [formatLine(summaries, { ...full, style })];
      // Too narrow: drop the countdowns rather than cut a provider off.
      const compact = { now, windowSep: " ", countdown: false };
      const plainCompact = formatLine(summaries, compact);
      if (textWidth(plainCompact) <= width) return [formatLine(summaries, { ...compact, style })];
      // Still too wide: plain text, clipped. Rows must never exceed the terminal width.
      return [clip(plainCompact, width)];
    };
    return {
      render(width: number): string[] {
        if (cached?.width !== width || cached.line !== lastLine) {
          cached = { width, line: lastLine, rows: rows(width) };
        }
        return cached.rows;
      },
      invalidate() {
        cached = undefined;
      },
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
        const reports = await source.reports(AbortSignal.timeout(FETCH_TIMEOUT_MS));
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
    lastLine = undefined;
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
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      let reports: UsageReport[];
      try {
        if (args.trim() === "refresh") {
          await Promise.all(settings.providers.map((p) => source.invalidate(p, signal)));
        }
        reports = await source.reports(signal);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Could not read subscription usage: ${reason}`, "error");
        return;
      }
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
