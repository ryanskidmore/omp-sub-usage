import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import subUsage, { buildSummaries, clip, STATUS_KEY } from "../src/extension.ts";
import { claudeReport, codexReport, NOW } from "./fixtures.ts";

// The fixtures are pinned to NOW; so is the extension's clock. HOME points at
// an empty directory so the developer's own omp plugin settings stay out.
const realHome = process.env.HOME;
const fakeHome = mkdtempSync(join(tmpdir(), "sub-usage-home-"));
beforeAll(() => {
  setSystemTime(new Date(NOW));
  process.env.HOME = fakeHome;
});
afterAll(() => {
  setSystemTime();
  process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type Component = { render(width: number): readonly string[]; dispose?(): void };
type WidgetFactory = (tui: { requestRender(): void }, theme: unknown) => Component;

const theme = {
  sep: { dot: " · " },
  fg: (color: string, text: string) => `\x1b[${color === "error" ? 31 : 32}m${text}\x1b[39m`,
};

interface HostOptions {
  cwd: string;
  mode: "tui" | "rpc";
  /** Canned reports, or a function called on every read. */
  reports: UsageReport[] | (() => Promise<UsageReport[]>);
}

function fakeHost(opts: HostOptions) {
  const handlers = new Map<string, Handler>();
  const statuses = new Map<string, string | undefined>();
  const statusCalls: (string | undefined)[] = [];
  const widgets = new Map<string, WidgetFactory | undefined>();
  const notes: { message: string; level?: string }[] = [];
  const invalidated: string[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const read = typeof opts.reports === "function" ? opts.reports : async () => opts.reports;
  const pi = {
    pi: { getAgentDir: () => join(fakeHome, ".omp", "agent") },
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
        usage: {
          reports: () => read(),
          invalidate: async (p: string) => void invalidated.push(p),
        },
        oauth: { identity: () => undefined },
      },
    },
    setInterval: () => 0,
    ui: {
      theme,
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
        statusCalls.push(text);
      },
      setWidget: (key: string, factory: WidgetFactory | undefined) => widgets.set(key, factory),
      notify: (message: string, level?: string) => notes.push({ message, level }),
    },
  };
  subUsage(pi as never);
  const emit = (event: string) => handlers.get(event)?.({}, ctx);
  const command = (args = "") => commands.get("sub-usage")?.handler(args, ctx);
  return { emit, command, statuses, statusCalls, widgets, notes, invalidated, ctx };
}

// Let fire-and-forget refreshes settle.
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

  async function widgetMode(reports: UsageReport[]) {
    const host = fakeHost({ cwd: project({ display: "widget" }), mode: "tui", reports });
    await host.emit("session_start");
    await settle();
    const factory = host.widgets.get(STATUS_KEY);
    if (!factory) throw new Error("widget not installed");
    return { host, component: factory({ requestRender() {} }, theme) };
  }

  test("status mode writes one plain footer line for both providers", async () => {
    const host = fakeHost({
      cwd: project(),
      mode: "tui",
      reports: [codexReport(), claudeReport()],
    });
    await host.emit("session_start");
    await settle();
    // Windows are space-separated: omp puts its own dot between extension statuses.
    expect(host.statuses.get(STATUS_KEY)).toBe(
      "Claude 5h 9% (2h 53m) 7d 2% (2d 6h) | Codex 7d 0% (6d 23h)",
    );
  });

  test("does not resend an unchanged status line", async () => {
    const host = fakeHost({ cwd: project(), mode: "rpc", reports: [claudeReport()] });
    await host.emit("session_start");
    await settle();
    await host.emit("turn_end");
    await settle();
    await host.emit("session_switch");
    await settle();
    expect(host.statusCalls).toHaveLength(1);
  });

  test("widget mode renders coloured, and never wider than the terminal", async () => {
    const { host, component } = await widgetMode([
      claudeReport({ fiveHour: 91 }),
      codexReport({ fiveHour: 12, weekly: 30 }),
    ]);
    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();

    const wide = component.render(200)[0] ?? "";
    expect(wide).toContain("\x1b[31m91%");
    expect(Bun.stringWidth(wide)).toBeLessThanOrEqual(200);

    for (const width of [70, 40, 10, 1]) {
      const row = component.render(width)[0] ?? "";
      expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
    }
    expect(component.render(70)[0]).not.toContain("(");
  });

  test("the narrow widget still shows a window past its reset as 0%", async () => {
    const { component } = await widgetMode([claudeReport({ fiveHour: 97 })]);
    setSystemTime(new Date(NOW + 3 * 3_600_000));
    try {
      // "Claude 5h 0% · 7d 2% (2d 3h)" is 28 columns; only the compact line fits in 20.
      const narrow = Bun.stripANSI(component.render(20)[0] ?? "");
      expect(narrow).toBe("Claude 5h 0% 7d 2%");
    } finally {
      setSystemTime(new Date(NOW));
    }
  });

  test("the widget reuses its rows until the line or width changes", async () => {
    const { component } = await widgetMode([claudeReport()]);
    const first = component.render(120);
    expect(component.render(120)).toBe(first);
    expect(component.render(119)).not.toBe(first);
  });

  test("widget mode falls back to the status line outside the TUI", async () => {
    const host = fakeHost({
      cwd: project({ display: "widget" }),
      mode: "rpc",
      reports: [claudeReport()],
    });
    await host.emit("session_start");
    await settle();
    expect(host.widgets.size).toBe(0);
    expect(host.statuses.get(STATUS_KEY)).toStartWith("Claude");
  });

  test("clears the footer when no provider reports usage", async () => {
    const host = fakeHost({ cwd: project(), mode: "tui", reports: [] });
    await host.emit("session_start");
    await settle();
    expect(host.statuses.has(STATUS_KEY)).toBe(true);
    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();
  });

  test("session_shutdown removes the widget and the status", async () => {
    const { host } = await widgetMode([claudeReport()]);
    expect(host.widgets.get(STATUS_KEY)).toBeFunction();
    await host.emit("session_shutdown");
    expect(host.widgets.get(STATUS_KEY)).toBeUndefined();
    expect(host.statuses.get(STATUS_KEY)).toBeUndefined();
  });

  test("overlapping refreshes share one read of the usage cache", async () => {
    let reads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const host = fakeHost({
      cwd: project(),
      mode: "tui",
      reports: async () => {
        reads++;
        await gate;
        return [claudeReport()];
      },
    });
    await host.emit("session_start");
    await host.emit("turn_end");
    await host.emit("turn_end");
    release();
    await settle();
    expect(reads).toBe(1);
    expect(host.statuses.get(STATUS_KEY)).toStartWith("Claude");
  });

  test("keeps the last good line when a read fails", async () => {
    let fail = false;
    const host = fakeHost({
      cwd: project(),
      mode: "tui",
      reports: async () => {
        if (fail) throw new Error("offline");
        return [claudeReport()];
      },
    });
    await host.emit("session_start");
    await settle();
    const good = host.statuses.get(STATUS_KEY);
    expect(good).toStartWith("Claude");
    fail = true;
    await host.emit("turn_end");
    await settle();
    expect(host.statuses.get(STATUS_KEY)).toBe(good);
  });

  test("/sub-usage notifies the full breakdown including model tiers", async () => {
    const host = fakeHost({ cwd: project(), mode: "tui", reports: [claudeReport()] });
    await host.command();
    expect(host.notes[0]?.message).toContain("7d fable");
    expect(host.notes[0]?.level).toBe("info");
    // …while the footer keeps its own modelLimits=false setting.
    expect(host.statuses.get(STATUS_KEY)).not.toContain("fable");
    expect(host.invalidated).toEqual([]);
  });

  test("/sub-usage refresh invalidates every configured provider first", async () => {
    const host = fakeHost({
      cwd: project({ providers: "openai-codex,anthropic,github-copilot" }),
      mode: "tui",
      reports: [claudeReport()],
    });
    await host.command("refresh");
    expect(host.invalidated).toEqual(["openai-codex", "anthropic", "github-copilot"]);
    expect(host.notes).toHaveLength(1);
  });

  test("/sub-usage reports a failed read instead of throwing", async () => {
    const host = fakeHost({
      cwd: project(),
      mode: "tui",
      reports: async () => {
        throw new Error("usage endpoint returned 503");
      },
    });
    await host.command();
    expect(host.notes).toEqual([
      { message: "Could not read subscription usage: usage endpoint returned 503", level: "error" },
    ]);
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
