/**
 * End-to-end: boots a real oh-my-pi in RPC mode with the plugin loaded and
 * checks what it puts in the footer and what `/sub-usage` prints.
 *
 * Usage data flows through omp's real AuthStorage; only the upstream usage
 * fetchers are replaced (see fake-usage.ts). No model is ever called: the
 * API key below only satisfies omp's "a model must exist" startup check.
 *
 * Two ways in: loaded directly with `-e`, and installed the way a user
 * would, with `omp plugin link` and configured with `omp plugin config`.
 *
 * Runs against the omp dev dependency by default. Set OMP_BIN to test
 * another build, e.g. the globally installed one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OMP = process.env.OMP_BIN ?? join(ROOT, "node_modules", ".bin", "omp");
const TIMEOUT_MS = 60_000;

type Frame = Record<string, unknown> & { type: string };

/** An isolated omp home: no user config, plugins, logins or sessions leak in. */
function ompEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
    ANTHROPIC_API_KEY: "sk-ant-integration-test",
    NO_COLOR: "1",
  };
}

function omp(home: string, ...args: string[]): string {
  const result = Bun.spawnSync([OMP, ...args], { cwd: home, env: ompEnv(home) });
  const out = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(`omp ${args.join(" ")} failed:\n${out}`);
  return out;
}

class RpcSession {
  readonly frames: Frame[] = [];
  #waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  #proc: ReturnType<typeof Bun.spawn>;
  #stderr = "";

  constructor(home: string, extraArgs: string[]) {
    this.#proc = Bun.spawn(
      [
        OMP,
        "--mode",
        "rpc",
        "--no-session",
        "-e",
        join(ROOT, "integration", "fake-usage.ts"),
        ...extraArgs,
      ],
      { cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: ompEnv(home) },
    );
    void this.#pump();
    void new Response(this.#proc.stderr as ReadableStream).text().then((t) => {
      this.#stderr = t;
    });
  }

  async #pump(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.#proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line.startsWith("{")) continue;
        const frame = JSON.parse(line) as Frame;
        this.frames.push(frame);
        this.#waiters = this.#waiters.filter((w) => {
          if (!w.match(frame)) return true;
          w.resolve(frame);
          return false;
        });
      }
    }
  }

  waitFor(match: (f: Frame) => boolean, what: string): Promise<Frame> {
    const seen = this.frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${what}\nstderr:\n${this.#stderr}`));
      }, TIMEOUT_MS);
      this.#waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolvePromise(f);
        },
      });
    });
  }

  send(message: Record<string, unknown>): void {
    const stdin = this.#proc.stdin as import("bun").FileSink;
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush();
  }

  async close(): Promise<number> {
    if (this.#proc.exitCode !== null) return this.#proc.exitCode;
    (this.#proc.stdin as import("bun").FileSink).end();
    const timer = setTimeout(() => this.#proc.kill(), 15_000);
    const code = await this.#proc.exited;
    clearTimeout(timer);
    return code;
  }
}

const isStatus = (f: Frame) => f.type === "extension_ui_request" && f.method === "setStatus";
const ourStatus = (f: Frame) => isStatus(f) && f.statusKey === "sub-usage";

describe(`loaded with -e, inside omp (${OMP})`, () => {
  let home: string;
  let rpc: RpcSession;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omp-sub-usage-it-"));
    rpc = new RpcSession(home, ["--no-extensions", "-e", join(ROOT, "src", "extension.ts")]);
    await rpc.waitFor((f) => f.type === "ready", "omp to become ready");
  }, TIMEOUT_MS);

  afterAll(async () => {
    await rpc?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test(
    "puts Claude and Codex windows with countdowns in the footer",
    async () => {
      const frame = await rpc.waitFor(
        (f) => ourStatus(f) && typeof f.statusText === "string",
        "the sub-usage footer status",
      );
      // The separator between windows comes from the active symbol preset.
      expect(frame.statusText).toMatch(
        /^Claude 5h 42% \(2h 13m\)( · | - )7d 17% \(3d 4h\) \| Codex 5h 81% \(40m\)( · | - )7d 23% \(6d\)$/,
      );
    },
    TIMEOUT_MS,
  );

  test(
    "/sub-usage prints the detailed breakdown",
    async () => {
      rpc.send({ id: "cmd-1", type: "prompt", message: "/sub-usage" });
      const frame = await rpc.waitFor(
        (f) => f.type === "extension_ui_request" && f.method === "notify",
        "the /sub-usage notification",
      );
      const message = String(frame.message);
      expect(message).toContain("Claude\n  5h          42%  resets in 2h 13m");
      expect(message).toContain("Codex (plus)");
      expect(message).toContain("saved resets: 1");
      // A command, not a prompt: the model must never be called.
      const result = await rpc.waitFor((f) => f.type === "prompt_result", "the prompt result");
      expect(result.agentInvoked).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "clears the footer on shutdown",
    async () => {
      const before = rpc.frames.length;
      const code = await rpc.close();
      expect(code).toBe(0);
      const cleared = rpc.frames
        .slice(before)
        .some((f) => ourStatus(f) && f.statusText === undefined);
      expect(cleared).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe(`installed with omp plugin link, inside omp (${OMP})`, () => {
  let home: string;
  let rpc: RpcSession;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omp-sub-usage-it-"));
    expect(omp(home, "plugin", "link", ROOT)).toContain("Linked omp-sub-usage");
    omp(home, "plugin", "config", "set", "omp-sub-usage", "providers", "openai-codex");
    // Installed plugins load before `-e` extensions, so the plugin's first read
    // precedes the fake providers; the periodic refresh picks them up.
    omp(home, "plugin", "config", "set", "omp-sub-usage", "refreshSeconds", "15");
    // Settings are validated against package.json#omp.settings.
    expect(() =>
      omp(home, "plugin", "config", "set", "omp-sub-usage", "display", "banner"),
    ).toThrow(/Must be one of: status, widget/);
    rpc = new RpcSession(home, []);
    await rpc.waitFor((f) => f.type === "ready", "omp to become ready");
  }, TIMEOUT_MS);

  afterAll(async () => {
    await rpc?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test(
    "omp discovers the plugin and it honours `omp plugin config`",
    async () => {
      const frame = await rpc.waitFor(
        (f) => ourStatus(f) && typeof f.statusText === "string",
        "the sub-usage footer status",
      );
      expect(frame.statusText).toMatch(/^Codex 5h 81% \(40m\)( · | - )7d 23% \(6d\)$/);
    },
    TIMEOUT_MS,
  );
});
