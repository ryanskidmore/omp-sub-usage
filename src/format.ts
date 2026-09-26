/**
 * Renders provider summaries as a single footer line, in the same shape as
 * omp's native `usage` status-line segment: `5h 42% (2h 13m)`.
 */
import type { ProviderSummary, Severity, WindowSummary } from "./usage.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Time until reset: minutes under an hour, "Xh Ym" under a day, "Xd Yh"
 * beyond. Returns "now" once the reset time has passed; the next fetch
 * brings the fresh window.
 */
export function formatCountdown(resetsAt: number, now: number): string {
  const diff = resetsAt - now;
  if (diff <= 0) return "now";
  if (diff < HOUR_MS) return `${Math.max(1, Math.floor(diff / MINUTE_MS))}m`;
  if (diff < DAY_MS) {
    const totalMinutes = Math.floor(diff / MINUTE_MS);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const totalHours = Math.floor(diff / HOUR_MS);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/** Styling hooks. The plain renderer leaves text untouched; the TUI widget colours it from the theme. */
export interface Stylist {
  name(text: string): string;
  percent(text: string, severity: Severity): string;
  muted(text: string): string;
}

const PLAIN: Stylist = {
  name: (t) => t,
  percent: (t) => t,
  muted: (t) => t,
};

export interface FormatOptions {
  now: number;
  /** Separator between windows of one provider. */
  windowSep?: string;
  /** Separator between providers. */
  providerSep?: string;
  style?: Stylist;
}

function formatWindow(w: WindowSummary, now: number, style: Stylist): string {
  // Past its reset time the snapshot is stale: the window has rolled over to
  // zero and the next one only starts counting from the next request.
  if (w.resetsAt !== undefined && w.resetsAt <= now) {
    return `${w.label} ${style.percent("0%", "ok")}`;
  }
  const reset =
    w.resetsAt !== undefined ? style.muted(` (${formatCountdown(w.resetsAt, now)})`) : "";
  return `${w.label} ${style.percent(`${Math.round(w.usedPercent)}%`, w.severity)}${reset}`;
}

export function formatLine(summaries: readonly ProviderSummary[], options: FormatOptions): string {
  const style = options.style ?? PLAIN;
  const windowSep = options.windowSep ?? " · ";
  const providerSep = options.providerSep ?? " | ";
  return summaries
    .filter((s) => s.windows.length > 0)
    .map((s) => {
      const windows = s.windows.map((w) => formatWindow(w, options.now, style)).join(windowSep);
      return `${style.name(s.name)} ${windows}`;
    })
    .join(providerSep);
}

function formatClock(epochMs: number, now: number): string {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (epochMs - now < 24 * HOUR_MS && d.getDate() === new Date(now).getDate()) return time;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/** Multi-line breakdown for the `/sub-usage` command: every window, with absolute reset times. */
export function formatDetails(summaries: readonly ProviderSummary[], now: number): string {
  if (summaries.length === 0)
    return "No Claude or Codex subscription usage available. Log in with /login.";
  const lines: string[] = [];
  for (const s of summaries) {
    lines.push(s.plan ? `${s.name} (${s.plan})` : s.name);
    if (s.windows.length === 0) lines.push("  no usage windows reported");
    for (const w of s.windows) {
      const pct = `${Math.round(w.usedPercent)}%`.padStart(4);
      const reset =
        w.resetsAt === undefined
          ? ""
          : w.resetsAt <= now
            ? "  reset"
            : `  resets in ${formatCountdown(w.resetsAt, now)} (${formatClock(w.resetsAt, now)})`;
      lines.push(`  ${w.label.padEnd(10)} ${pct}${reset}`);
    }
    if (s.savedResets) lines.push(`  saved resets: ${s.savedResets}`);
  }
  return lines.join("\n");
}
