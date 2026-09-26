import { describe, expect, test } from "bun:test";
import { formatCountdown, formatDetails, formatLine } from "../src/format.ts";
import { summarize } from "../src/usage.ts";
import { claudeReport, codexReport, NOW } from "./fixtures.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("formatCountdown", () => {
  test.each([
    [30_000, "1m"],
    [42 * MIN, "42m"],
    [HOUR, "1h"],
    [2 * HOUR + 53 * MIN + 59_000, "2h 53m"],
    [24 * HOUR, "1d"],
    [6 * 24 * HOUR + 23 * HOUR + 59 * MIN, "6d 23h"],
    [-1, "now"],
  ])("%p ms → %p", (diff, expected) => {
    expect(formatCountdown(NOW + diff, NOW)).toBe(expected);
  });
});

describe("formatLine", () => {
  test("renders both providers like omp's native usage segment", () => {
    const line = formatLine(
      [
        summarize(claudeReport({ fiveHour: 42, weekly: 17 })),
        summarize(codexReport({ weekly: 3 })),
      ],
      {
        now: NOW,
      },
    );
    expect(line).toBe("Claude 5h 42% (2h 53m) · 7d 17% (2d 6h) | Codex 7d 3% (6d 23h)");
  });

  test("shows a window past its reset as 0% with no countdown", () => {
    const line = formatLine([summarize(claudeReport({ fiveHour: 97 }))], { now: NOW + 3 * HOUR });
    expect(line.startsWith("Claude 5h 0% · 7d")).toBe(true);
  });

  test("omits providers with no windows and returns empty when nothing is left", () => {
    const empty = { provider: "anthropic", name: "Claude", windows: [] };
    expect(formatLine([empty], { now: NOW })).toBe("");
  });

  test("applies the stylist per severity", () => {
    const line = formatLine([summarize(claudeReport({ fiveHour: 85, weekly: 60 }))], {
      now: NOW,
      style: { name: (t) => `<${t}>`, percent: (t, s) => `[${s}:${t}]`, muted: (t) => t },
    });
    expect(line).toBe("<Claude> 5h [critical:85%] (2h 53m) · 7d [warning:60%] (2d 6h)");
  });
});

describe("formatDetails", () => {
  test("lists every window with plan and saved resets", () => {
    const text = formatDetails(
      [summarize(claudeReport(), { modelLimits: true }), summarize(codexReport({ weekly: 3 }))],
      NOW,
    );
    expect(text).toContain("Claude\n  5h");
    expect(text).toContain("7d fable");
    expect(text).toContain("Codex (plus)");
    expect(text).toContain("saved resets: 2");
    expect(text).toContain("resets in 6d 23h");
  });

  test("points at /login when there is nothing to show", () => {
    expect(formatDetails([], NOW)).toContain("/login");
  });
});
