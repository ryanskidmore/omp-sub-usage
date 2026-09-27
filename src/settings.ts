/**
 * Plugin settings, declared in `package.json#omp.settings` so omp's own
 * tooling manages them (`omp plugin config set omp-sub-usage <key> <value>`
 * and the plugin settings panel). omp persists them in its plugin lockfile
 * and, per project, in `.omp/plugin-overrides.json`; this reads both the
 * same way omp's `PluginManager.getPluginSettings` does. That helper is not
 * part of the extension API, hence the small reimplementation.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const PLUGIN_NAME = "omp-sub-usage";

export type Display = "status" | "widget";

export interface Settings {
  /** Provider ids to show, in order. */
  providers: string[];
  /** "status": omp's footer status line (plain text). "widget": coloured line below the editor. */
  display: Display;
  /** Include per-model tier windows such as Claude's Fable weekly cap. */
  modelLimits: boolean;
  /** How often to re-read usage, in seconds. omp's own cache decides when that hits the network. */
  refreshSeconds: number;
}

export const DEFAULTS: Settings = {
  providers: ["anthropic", "openai-codex"],
  display: "status",
  modelLimits: false,
  refreshSeconds: 60,
};

/** Bounds for `refreshSeconds`; `package.json#omp.settings` declares the same. */
export const MIN_REFRESH_SECONDS = 15;
export const MAX_REFRESH_SECONDS = 3600;

/** A number, or a numeric string; anything else (including "" and null) is NaN. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/** Coerce raw, possibly hand-edited values into Settings, keeping defaults for anything invalid. */
export function parseSettings(raw: Record<string, unknown>): Settings {
  const out: Settings = { ...DEFAULTS, providers: [...DEFAULTS.providers] };

  const providers = raw.providers;
  if (typeof providers === "string") {
    const list = providers
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (list.length > 0) out.providers = list;
  }

  if (raw.display === "status" || raw.display === "widget") out.display = raw.display;

  const modelLimits = raw.modelLimits;
  if (typeof modelLimits === "boolean") out.modelLimits = modelLimits;
  else if (modelLimits === "true" || modelLimits === "false")
    out.modelLimits = modelLimits === "true";

  const refresh = toNumber(raw.refreshSeconds);
  if (Number.isFinite(refresh)) {
    out.refreshSeconds = Math.min(
      MAX_REFRESH_SECONDS,
      Math.max(MIN_REFRESH_SECONDS, Math.round(refresh)),
    );
  }
  return out;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function pluginEntry(file: Record<string, unknown> | undefined): Record<string, unknown> {
  const settings = file?.settings as Record<string, unknown> | undefined;
  const entry = settings?.[PLUGIN_NAME];
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
}

export interface HostPaths {
  /** omp's agent directory (`pi.pi.getAgentDir()`). */
  agentDir?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Defaults to `$HOME`, falling back to the OS home directory. */
  home?: string;
}

/**
 * Where omp keeps `omp-plugins.lock.json`, resolved the way omp's
 * `getPluginsLockfile` does (pi-utils `dirs.ts`):
 *
 * - the config root is `~/.omp` (`$PI_CONFIG_DIR` renames `.omp`), or
 *   `~/.omp/profiles/<name>` under a profile;
 * - on Linux and macOS, once `$XDG_DATA_HOME/omp` (or its `profiles/<name>`)
 *   exists, data moves there instead;
 * - a custom agent directory (`PI_CODING_AGENT_DIR`) keeps the default config
 *   root and turns the XDG move off.
 *
 * The profile and the custom directory are told apart by the agent directory
 * omp reports, since neither is otherwise visible to an extension.
 */
export function lockfilePath(paths: HostPaths = {}): string {
  const env = paths.env ?? process.env;
  const platform = paths.platform ?? process.platform;
  const home = paths.home ?? (env.HOME || homedir());
  const base = join(home, env.PI_CONFIG_DIR || ".omp");

  let configRoot = base;
  // Path under `$XDG_DATA_HOME/omp` for this root; undefined when XDG does not apply.
  let xdgSubdir: string[] | undefined = [];
  if (paths.agentDir !== undefined) {
    const root = dirname(paths.agentDir);
    if (basename(paths.agentDir) === "agent" && dirname(root) === join(base, "profiles")) {
      configRoot = root;
      xdgSubdir = ["profiles", basename(root)];
    } else if (paths.agentDir !== join(base, "agent")) {
      xdgSubdir = undefined;
    }
  }

  if (xdgSubdir && env.XDG_DATA_HOME && (platform === "linux" || platform === "darwin")) {
    const xdgRoot = join(env.XDG_DATA_HOME, "omp", ...xdgSubdir);
    if (existsSync(xdgRoot)) return join(xdgRoot, "plugins", "omp-plugins.lock.json");
  }
  return join(configRoot, "plugins", "omp-plugins.lock.json");
}

/**
 * Global settings from the plugin lockfile, overlaid with the project's
 * `.omp/plugin-overrides.json`. `omp plugin config set` writes the lockfile
 * even for project-scoped installs, so these are the only two sources.
 */
export function loadSettings(options: { cwd: string } & HostPaths): Settings {
  const global = pluginEntry(readJson(lockfilePath(options)));
  const project = pluginEntry(readJson(join(options.cwd, ".omp", "plugin-overrides.json")));
  return parseSettings({ ...global, ...project });
}
