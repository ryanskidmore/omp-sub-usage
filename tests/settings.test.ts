import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadSettings, lockfileCandidates, parseSettings } from "../src/settings.ts";

describe("parseSettings", () => {
  test("defaults", () => {
    expect(parseSettings({})).toEqual(DEFAULTS);
  });

  test("coerces values the way `omp plugin config set` stores them", () => {
    expect(
      parseSettings({
        providers: " openai-codex , anthropic ",
        display: "widget",
        modelLimits: "true",
        refreshSeconds: "120",
      }),
    ).toEqual({
      providers: ["openai-codex", "anthropic"],
      display: "widget",
      modelLimits: true,
      refreshSeconds: 120,
    });
  });

  test("ignores invalid values and clamps the refresh interval", () => {
    const s = parseSettings({ providers: " , ", display: "banner", refreshSeconds: 1 });
    expect(s.providers).toEqual(DEFAULTS.providers);
    expect(s.display).toBe("status");
    expect(s.refreshSeconds).toBe(15);
  });
});

describe("loadSettings", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("merges the plugin lockfile with project overrides", () => {
    dir = mkdtempSync(join(tmpdir(), "sub-usage-"));
    const agentDir = join(dir, "home", "agent");
    mkdirSync(join(dir, "home", "plugins"), { recursive: true });
    writeFileSync(
      join(dir, "home", "plugins", "omp-plugins.lock.json"),
      JSON.stringify({
        plugins: {},
        settings: { "omp-sub-usage": { display: "widget", refreshSeconds: 30 } },
      }),
    );
    const project = join(dir, "project");
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(
      join(project, ".omp", "plugin-overrides.json"),
      JSON.stringify({ settings: { "omp-sub-usage": { refreshSeconds: 90 } } }),
    );
    const s = loadSettings({ cwd: project, agentDir });
    expect(s.display).toBe("widget");
    expect(s.refreshSeconds).toBe(90);
  });

  test("lockfile candidates put XDG first when set", () => {
    const c = lockfileCandidates("/h/.omp/agent", { XDG_DATA_HOME: "/xdg" });
    expect(c[0]).toBe("/xdg/omp/plugins/omp-plugins.lock.json");
    expect(c[1]).toBe("/h/.omp/plugins/omp-plugins.lock.json");
  });
});
