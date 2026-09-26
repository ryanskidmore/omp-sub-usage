/**
 * Reads usage through the host's own AuthStorage, so the plugin sees exactly
 * what omp's `/usage` command and credential ranking see: same OAuth logins,
 * same cache, same header-fed updates after every Claude/Codex response.
 *
 * omp 18.2 moved AuthStorage onto namespaces (`usage.reports()`,
 * `oauth.identity()`); 18.1 exposed flat methods. Both are supported, found
 * by feature detection rather than version sniffing.
 */
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { AccountIdentity } from "./usage.ts";

type BaseUrlResolver = (provider: string) => string | undefined;
interface ReportOptions {
  baseUrlResolver?: BaseUrlResolver;
  signal?: AbortSignal;
}

/** The parts of omp's AuthStorage (either API generation) this plugin uses. */
export interface HostAuthStorage {
  usage?: {
    reports(options?: ReportOptions): Promise<UsageReport[] | null>;
    invalidate(provider?: string, signal?: AbortSignal): Promise<void>;
  };
  oauth?: { identity(provider: string, sessionId?: string): AccountIdentity | undefined };
  fetchUsageReports?(options?: ReportOptions): Promise<UsageReport[] | null>;
  invalidateUsageCache?(provider?: string, signal?: AbortSignal): Promise<void>;
  getOAuthAccountIdentity?(provider: string, sessionId?: string): AccountIdentity | undefined;
}

export interface HostModelRegistry {
  authStorage?: unknown;
  getProviderBaseUrl?(provider: string): string | undefined;
}

export interface UsageSource {
  reports(signal?: AbortSignal): Promise<UsageReport[]>;
  identity(provider: string, sessionId?: string): AccountIdentity | undefined;
  invalidate(provider: string): Promise<void>;
}

/** Wrap the host registry's AuthStorage, or undefined when it exposes no usage API. */
export function usageSource(registry: HostModelRegistry | undefined): UsageSource | undefined {
  const auth = registry?.authStorage as HostAuthStorage | undefined;
  if (!auth) return undefined;
  const reportsFn = auth.usage?.reports
    ? auth.usage.reports.bind(auth.usage)
    : auth.fetchUsageReports?.bind(auth);
  if (!reportsFn) return undefined;
  const invalidateFn = auth.usage?.invalidate
    ? auth.usage.invalidate.bind(auth.usage)
    : auth.invalidateUsageCache?.bind(auth);
  const identityFn = auth.oauth?.identity
    ? auth.oauth.identity.bind(auth.oauth)
    : auth.getOAuthAccountIdentity?.bind(auth);
  // Same base-URL resolution AgentSession.fetchUsageReports uses, so custom
  // provider endpoints from models.yml are honoured.
  const baseUrlResolver: BaseUrlResolver = (provider) => registry?.getProviderBaseUrl?.(provider);

  return {
    async reports(signal) {
      return (await reportsFn({ baseUrlResolver, signal })) ?? [];
    },
    identity(provider, sessionId) {
      try {
        return identityFn?.(provider, sessionId);
      } catch {
        return undefined;
      }
    },
    async invalidate(provider) {
      await invalidateFn?.(provider);
    },
  };
}
