import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import subUsage, { buildSummaries, clip, STATUS_KEY } from "../src/extension.ts";
import { claudeReport, codexReport, NOW } from "./fixtures.ts";

// The fixtures are pinned to NOW; so is the extension's clock.
beforeAll(() => setSystemTime(new Date(NOW)));
afterAll(() => setSystemTime());

type Handler = (event: unknown, ctx: unknown) => unknown;
type WidgetFactory = (
  tui: { requestRender(): void },
  theme: unknown,
) => { render(width: number): readonly string[] };

const theme = {
  sep: { dot: " · " },
  fg: (color: string, text: string) => `\x1b[${color === "error" ? 31 : 32}m${text}\x1b[39m`,
};

function fakeHost(opts: { cwd: string; mode: "tui" | "rpc"; reports: UsageReport[] }) {
  const handlers = new Map<string, Handler>();
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, WidgetFactory | undefined>();
  const notes: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    pi: { getAgentDir: () => join(opts.cwd, "no-such-agent-dir") },
    logger: { debug() {} },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, cmd: { handler: (a: string, c: unknown) => Promise<void> }) =>
      commands.set(name, cmd),
  };
  const ctx = {
    hasUI: true,
    mode: opts.mode,
    cwd: opts.cwd,
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: {
      authStorage: {
        usage: { reports: async () => opts.reports, invalidate: async () => {} },
        oauth: { identity: () => undefined },
      },
    },
    setInterval: () => 0,
    ui: {
      theme,
      setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
      setWidget: (key: string, factory: WidgetFactory | undefined) => widgets.set(key, factory),
      notify: (message: string) => notes.push(message),
    },
  };
  subUsage(pi as never);
  return { handlers, statuses, widgets, notes, commands, ctx };
}

// Let the fire-and-forget refresh from session_start settle.
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("extension", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function project(settings?: Record<string, unknown>): string {
    dir = mkdtempSync(join(tmpdir(), "sub-usage-ext-"));
    if (settings) {
      mkdirSync(join(dir, ".omp"));
      writeFileSync(
        join(dir, ".omp", "plugin-overrides.json"),
        JSON.stringify({ settings: { "omp-sub-usage": settings } }),
      );
    }
    return dir;
  }

  test("status mode writes one plain footer line for both providers", async () => {
    const host = fakeHost({
      cwd: project(),
      mode: "tui",
      reports: [codexReport(), claudeReport()],
    });
    await host.handlers.get("session_start")?.({}, host.ctx);
    await settle();
    const line = host.statuses.get(STATUS_KEY);
    expect(line).toStartWith("Claude 5h 9% (");
    expect(line).toContain(" | Codex 7d 0% (");
  });

  test("widget mode renders coloured, and never wider than the terminal", async () => {
    const host = fakeHost({
      cwd: project({ display: "widget" }),
      mode: "tui",
      reports: [claudeReport({ fiveHour: 91 }), codexReport({ fiveHour: 12, weekly: 30 })],
    });
    await host.handlers.get("session_start")?.({}, host.ctx);
    await settle();
    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();
    const factory = host.widgets.get(STATUS_KEY);
    if (!factory) throw new Error("widget not installed");
    const component = factory({ requestRender() {} }, theme);

    const wide = component.render(200)[0] ?? "";
    expect(wide).toContain("\x1b[31m91%");
    expect(Bun.stringWidth(wide)).toBeLessThanOrEqual(200);

    for (const width of [70, 40, 10, 1]) {
      const row = component.render(width)[0] ?? "";
      expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
    }
    expect(component.render(70)[0]).not.toContain("(");
  });

  test("widget mode falls back to the status line outside the TUI", async () => {
    const host = fakeHost({
      cwd: project({ display: "widget" }),
      mode: "rpc",
      reports: [claudeReport()],
    });
    await host.handlers.get("session_start")?.({}, host.ctx);
    await settle();
    expect(host.widgets.size).toBe(0);
    expect(host.statuses.get(STATUS_KEY)).toStartWith("Claude");
  });

  test("clears the footer when no provider reports usage", async () => {
    const host = fakeHost({ cwd: project(), mode: "tui", reports: [] });
    await host.handlers.get("session_start")?.({}, host.ctx);
    await settle();
    expect(host.statuses.has(STATUS_KEY)).toBe(true);
    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();
  });

  test("/sub-usage notifies the full breakdown including model tiers", async () => {
    const host = fakeHost({ cwd: project(), mode: "tui", reports: [claudeReport()] });
    await host.commands.get("sub-usage")?.handler("", host.ctx);
    expect(host.notes[0]).toContain("7d fable");
    // …while the footer keeps its own modelLimits=false setting.
    expect(host.statuses.get(STATUS_KEY)).not.toContain("fable");
  });
});

describe("buildSummaries", () => {
  test("follows the configured provider order and skips missing providers", () => {
    const summaries = buildSummaries(
      [claudeReport(), codexReport()],
      { providers: ["openai-codex", "github-copilot", "anthropic"], modelLimits: false },
      () => undefined,
    );
    expect(summaries.map((s) => s.name)).toEqual(["Codex", "Claude"]);
  });
});

describe("clip", () => {
  test("leaves short text alone and marks cuts", () => {
    expect(clip("Claude 5h 9%", 20)).toBe("Claude 5h 9%");
    expect(clip("Claude 5h 9%", 8)).toBe("Claude …");
    expect(clip("Claude", 0)).toBe("");
  });
});
