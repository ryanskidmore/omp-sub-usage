import { describe, expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { usageSource } from "../src/source.ts";
import { claudeReport } from "./fixtures.ts";

const reports: UsageReport[] = [claudeReport()];

describe("usageSource", () => {
  test("uses the namespaced AuthStorage API (omp 18.3+)", async () => {
    const calls: string[] = [];
    const source = usageSource({
      getProviderBaseUrl: (p) => (p === "anthropic" ? "https://proxy.example" : undefined),
      authStorage: {
        usage: {
          reports: async (opts?: { baseUrlResolver?: (p: string) => string | undefined }) => {
            calls.push(`reports:${opts?.baseUrlResolver?.("anthropic")}`);
            return reports;
          },
          invalidate: async (p?: string, signal?: AbortSignal) =>
            void calls.push(`invalidate:${p}:${signal?.aborted}`),
        },
        oauth: { identity: (p: string, sid?: string) => ({ email: `${p}:${sid}` }) },
      },
    });
    expect(await source?.reports()).toBe(reports);
    await source?.invalidate("anthropic", new AbortController().signal);
    expect(source?.identity("anthropic", "s1")).toEqual({ email: "anthropic:s1" });
    expect(calls).toEqual(["reports:https://proxy.example", "invalidate:anthropic:false"]);
  });

  test("falls back to the flat AuthStorage API (omp 18.1–18.2)", async () => {
    const source = usageSource({
      authStorage: {
        fetchUsageReports: async () => null,
        getOAuthAccountIdentity: () => ({ accountId: "a" }),
      },
    });
    expect(await source?.reports()).toEqual([]);
    expect(source?.identity("anthropic")).toEqual({ accountId: "a" });
  });

  test("is undefined when the host has no usage API", () => {
    expect(usageSource({ authStorage: {} })).toBeUndefined();
    expect(usageSource(undefined)).toBeUndefined();
  });

  test("swallows identity lookup errors", () => {
    const source = usageSource({
      authStorage: {
        fetchUsageReports: async () => [],
        getOAuthAccountIdentity: () => {
          throw new Error("locked");
        },
      },
    });
    expect(source?.identity("anthropic")).toBeUndefined();
  });
});
