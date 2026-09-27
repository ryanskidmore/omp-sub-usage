import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadSettings, lockfilePath, parseSettings } from "../src/settings.ts";

describe("parseSettings", () => {
  test("defaults", () => {
    expect(parseSettings({})).toEqual(DEFAULTS);
  });

  test("takes the typed values `omp plugin config set` stores", () => {
    expect(
      parseSettings({
        providers: "openai-codex,anthropic",
        display: "widget",
        modelLimits: true,
        refreshSeconds: 120,
      }),
    ).toEqual({
      providers: ["openai-codex", "anthropic"],
      display: "widget",
      modelLimits: true,
      refreshSeconds: 120,
    });
  });

  test("coerces hand-edited strings", () => {
    expect(
      parseSettings({
        providers: " openai-codex , anthropic ",
        modelLimits: "true",
        refreshSeconds: "120",
      }),
    ).toMatchObject({
      providers: ["openai-codex", "anthropic"],
      modelLimits: true,
      refreshSeconds: 120,
    });
  });

  test("ignores invalid values and clamps the refresh interval to the manifest's bounds", () => {
    const s = parseSettings({ providers: " , ", display: "banner", refreshSeconds: 1 });
    expect(s.providers).toEqual(DEFAULTS.providers);
    expect(s.display).toBe("status");
    expect(s.refreshSeconds).toBe(15);
    expect(parseSettings({ refreshSeconds: 86_400 }).refreshSeconds).toBe(3600);
    for (const junk of [null, "", " ", "soon", false, Number.NaN]) {
      expect(parseSettings({ refreshSeconds: junk }).refreshSeconds).toBe(DEFAULTS.refreshSeconds);
    }
  });
});

describe("lockfilePath", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const lock = (...parts: string[]) => join(...parts, "plugins", "omp-plugins.lock.json");

  function home(): string {
    dir = mkdtempSync(join(tmpdir(), "sub-usage-home-"));
    return dir;
  }

  test("defaults to ~/.omp/plugins", () => {
    const h = home();
    expect(lockfilePath({ home: h, env: {}, agentDir: join(h, ".omp", "agent") })).toBe(
      lock(h, ".omp"),
    );
    expect(lockfilePath({ home: h, env: {} })).toBe(lock(h, ".omp"));
  });

  test("honours PI_CONFIG_DIR", () => {
    const h = home();
    const env = { PI_CONFIG_DIR: ".omp-dev" };
    expect(lockfilePath({ home: h, env, agentDir: join(h, ".omp-dev", "agent") })).toBe(
      lock(h, ".omp-dev"),
    );
  });

  test("moves to $XDG_DATA_HOME/omp only once that directory exists", () => {
    const h = home();
    const env = { XDG_DATA_HOME: join(h, "xdg") };
    const agentDir = join(h, ".omp", "agent");
    expect(lockfilePath({ home: h, env, agentDir, platform: "linux" })).toBe(lock(h, ".omp"));
    mkdirSync(join(h, "xdg", "omp"), { recursive: true });
    expect(lockfilePath({ home: h, env, agentDir, platform: "linux" })).toBe(lock(h, "xdg", "omp"));
    expect(lockfilePath({ home: h, env, agentDir, platform: "win32" })).toBe(lock(h, ".omp"));
  });

  test("keeps the default root, without XDG, for a custom agent directory", () => {
    const h = home();
    mkdirSync(join(h, "xdg", "omp"), { recursive: true });
    const env = { XDG_DATA_HOME: join(h, "xdg") };
    expect(
      lockfilePath({ home: h, env, agentDir: join(h, "elsewhere", "agent"), platform: "linux" }),
    ).toBe(lock(h, ".omp"));
  });

  test("uses the profile's own root, and its own XDG directory", () => {
    const h = home();
    const env = { XDG_DATA_HOME: join(h, "xdg") };
    const agentDir = join(h, ".omp", "profiles", "work", "agent");
    // The base XDG directory alone does not move a profile.
    mkdirSync(join(h, "xdg", "omp"), { recursive: true });
    expect(lockfilePath({ home: h, env, agentDir, platform: "linux" })).toBe(
      lock(h, ".omp", "profiles", "work"),
    );
    mkdirSync(join(h, "xdg", "omp", "profiles", "work"), { recursive: true });
    expect(lockfilePath({ home: h, env, agentDir, platform: "linux" })).toBe(
      lock(h, "xdg", "omp", "profiles", "work"),
    );
  });
});

describe("loadSettings", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("merges the plugin lockfile with project overrides", () => {
    dir = mkdtempSync(join(tmpdir(), "sub-usage-"));
    const home = join(dir, "home");
    mkdirSync(join(home, ".omp", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".omp", "plugins", "omp-plugins.lock.json"),
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
    const s = loadSettings({ cwd: project, home, env: {}, agentDir: join(home, ".omp", "agent") });
    expect(s.display).toBe("widget");
    expect(s.refreshSeconds).toBe(90);
  });

  test("falls back to defaults when neither file exists", () => {
    dir = mkdtempSync(join(tmpdir(), "sub-usage-"));
    expect(loadSettings({ cwd: dir, home: dir, env: {} })).toEqual(DEFAULTS);
  });
});
