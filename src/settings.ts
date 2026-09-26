/**
 * Plugin settings, declared in `package.json#omp.settings` so omp's own
 * tooling manages them (`omp plugin config set omp-sub-usage <key> <value>`
 * and the plugin settings panel). omp persists them in its plugin lockfile
 * and, per project, in `.omp/plugin-overrides.json`; this reads both the
 * same way omp's `getPluginSettings` does. That helper is not part of the
 * extension API, hence the small reimplementation.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

const MIN_REFRESH_SECONDS = 15;

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

  const refresh = Number(raw.refreshSeconds);
  if (raw.refreshSeconds !== undefined && Number.isFinite(refresh)) {
    out.refreshSeconds = Math.max(MIN_REFRESH_SECONDS, Math.round(refresh));
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

/**
 * Where omp keeps `omp-plugins.lock.json`: `$XDG_DATA_HOME/omp/plugins` once
 * migrated to XDG on Linux, otherwise the config root (`~/.omp/plugins`).
 */
export function lockfileCandidates(agentDir?: string, env = process.env): string[] {
  const name = "omp-plugins.lock.json";
  const out: string[] = [];
  if (env.XDG_DATA_HOME) out.push(join(env.XDG_DATA_HOME, "omp", "plugins", name));
  if (agentDir) out.push(join(dirname(agentDir), "plugins", name));
  out.push(join(homedir(), ".omp", "plugins", name));
  return [...new Set(out)];
}

export function loadSettings(options: { cwd: string; agentDir?: string }): Settings {
  let global: Record<string, unknown> = {};
  for (const path of lockfileCandidates(options.agentDir)) {
    const file = readJson(path);
    if (file) {
      global = pluginEntry(file);
      break;
    }
  }
  const project = pluginEntry(readJson(join(options.cwd, ".omp", "plugin-overrides.json")));
  return parseSettings({ ...global, ...project });
}
