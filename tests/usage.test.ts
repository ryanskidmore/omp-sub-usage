import { describe, expect, test } from "bun:test";
import { selectReport, severityFor, summarize, usedFraction, windowLabel } from "../src/usage.ts";
import { claudeReport, codexReport, NOW } from "./fixtures.ts";

describe("summarize", () => {
  test("keeps shared time windows, shortest first, and skips spend and tier limits", () => {
    const s = summarize(claudeReport({ fiveHour: 42, weekly: 17 }));
    expect(s.name).toBe("Claude");
    expect(s.windows.map((w) => [w.label, Math.round(w.usedPercent)])).toEqual([
      ["5h", 42],
      ["7d", 17],
    ]);
    expect(s.windows[0]?.resetsAt).toBe(NOW + 2 * 3_600_000 + 53 * 60_000);
  });

  test("includes model tier windows when asked, after the shared window", () => {
    const s = summarize(claudeReport(), { modelLimits: true });
    expect(s.windows.map((w) => w.label)).toEqual(["5h", "7d", "7d fable"]);
  });

  test("handles a Codex account that only reports a weekly window", () => {
    const s = summarize(codexReport({ weekly: 12 }));
    expect(s.name).toBe("Codex");
    expect(s.plan).toBe("plus");
    expect(s.savedResets).toBe(2);
    expect(s.windows.map((w) => w.label)).toEqual(["7d"]);
  });

  test("orders Codex 5h ahead of 7d regardless of primary/secondary naming", () => {
    const s = summarize(codexReport({ fiveHour: 55, weekly: 20 }));
    expect(s.windows.map((w) => [w.label, w.severity])).toEqual([
      ["5h", "warning"],
      ["7d", "ok"],
    ]);
  });

  test("derives the window length from the id when durationMs is missing", () => {
    const report = claudeReport();
    const first = report.limits[0];
    if (first?.window) first.window.durationMs = undefined;
    expect(summarize(report).windows[0]?.label).toBe("5h");
  });
});

describe("selectReport", () => {
  const reports = [
    codexReport({ accountId: "work", weekly: 90 }),
    codexReport({ accountId: "personal", weekly: 10 }),
    claudeReport(),
  ];

  test("prefers the report for the session's active account", () => {
    const r = selectReport(reports, "openai-codex", { accountId: "personal" });
    expect(r?.metadata?.accountId).toBe("personal");
  });

  test("falls back to the first report when nothing matches", () => {
    expect(selectReport(reports, "openai-codex", { email: "x@y" })?.metadata?.accountId).toBe(
      "work",
    );
    expect(selectReport(reports, "openai-codex")?.metadata?.accountId).toBe("work");
  });

  test("returns undefined for a provider with no report", () => {
    expect(selectReport(reports, "github-copilot")).toBeUndefined();
  });
});

describe("helpers", () => {
  test("severity uses omp's native 50/80 thresholds and honours exhaustion", () => {
    expect(severityFor(49)).toBe("ok");
    expect(severityFor(50)).toBe("warning");
    expect(severityFor(80)).toBe("critical");
    expect(severityFor(10, true)).toBe("critical");
  });

  test("usedFraction falls back through the amount fields", () => {
    const base = { id: "x", label: "x", scope: { provider: "anthropic" } };
    expect(usedFraction({ ...base, amount: { used: 30, limit: 60, unit: "tokens" } })).toBe(0.5);
    expect(usedFraction({ ...base, amount: { used: 25, unit: "percent" } })).toBe(0.25);
    expect(usedFraction({ ...base, amount: { remainingFraction: 0.75, unit: "unknown" } })).toBe(
      0.25,
    );
    expect(usedFraction({ ...base, amount: { unit: "unknown" } })).toBeUndefined();
  });

  test("windowLabel prefers days, then hours, then the provider id", () => {
    expect(windowLabel(7 * 86_400_000, "x")).toBe("7d");
    expect(windowLabel(5 * 3_600_000, "x")).toBe("5h");
    expect(windowLabel(90 * 60_000, "90m")).toBe("90m");
  });
});
