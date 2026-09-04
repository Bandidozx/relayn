/**
 * Provider registry — the single place the gateway resolves an upstream from a catalogue row.
 *
 * Two sources feed it:
 *
 *   **Builtins** are compiled in from `env`. They ship with the deployment, their credentials
 *   live in `process.env`, and they cannot be edited or removed from the dashboard.
 *
 *   **Custom providers** are rows in `provider_configs` with `custom = true`, added by an
 *   operator at runtime from Admin → Providers. This is what makes reselling a third-party
 *   gateway possible without a redeploy: the row carries the base URL, the dialect, and the
 *   credential sealed by `lib/security/secret-box`.
 *
 * A builtin id always wins over a custom row claiming the same id, so a custom row can never
 * shadow `openai` or `anthropic` and quietly redirect their traffic elsewhere. The write path
 * rejects such ids up front (`isReservedProviderId`); this is the second line of defence.
 *
 * Resolution is async because of the database read, and cached in-process for
 * `CACHE_TTL_MS`. Admin writes call `invalidateProviderCache()`, which is exact for the
 * instance that served the write; on a multi-instance deployment other instances converge
 * within the TTL. That is the reason the TTL is seconds rather than minutes.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { AnthropicProvider } from "@/lib/providers/anthropic";
import { MockProvider } from "@/lib/providers/mock";
import { OpenAiCompatibleProvider } from "@/lib/providers/openai-compatible";
import { ProxyPool, parseProxyList, type ParsedProxy } from "@/lib/providers/proxy";
import type { HealthStatus, ModelProvider } from "@/lib/providers/types";
import { SecretBoxError, openSecret } from "@/lib/security/secret-box";

/** Upstream dialects a custom provider may speak. */
export const PROVIDER_KINDS = ["openai", "anthropic"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

const CACHE_TTL_MS = 30_000;

/** Looks up the outbound proxy pool for a provider id while a snapshot is being composed. */
type ProxyLookup = (providerId: string) => ProxyPool | null;

const noProxies: ProxyLookup = () => null;

function builtins(proxyFor: ProxyLookup = noProxies): ModelProvider[] {
  return [
    new OpenAiCompatibleProvider({
      id: "openai",
      label: "OpenAI",
      credentialEnvVar: "OPENAI_API_KEY",
      baseUrl: env.providers.openai.baseUrl,
      apiKey: env.providers.openai.apiKey,
      proxyPool: proxyFor("openai"),
    }),
    new AnthropicProvider({
      baseUrl: env.providers.anthropic.baseUrl,
      apiKey: env.providers.anthropic.apiKey,
      proxyPool: proxyFor("anthropic"),
    }),
    new OpenAiCompatibleProvider({
      id: "google",
      label: "Google AI Studio",
      credentialEnvVar: "GOOGLE_API_KEY",
      baseUrl: env.providers.google.baseUrl,
      apiKey: env.providers.google.apiKey,
      proxyPool: proxyFor("google"),
    }),
    new OpenAiCompatibleProvider({
      id: "openrouter",
      label: "OpenRouter",
      credentialEnvVar: "OPENROUTER_API_KEY",
      baseUrl: env.providers.openrouter.baseUrl,
      apiKey: env.providers.openrouter.apiKey,
      extraHeaders: {
        "http-referer": env.appUrl,
        "x-title": "Relayn",
      },
      proxyPool: proxyFor("openrouter"),
    }),
    new MockProvider(env.enableMockProvider),
    new OpenAiCompatibleProvider({
      id: "jerouter",
      label: "JeRouter",
      credentialEnvVar: "JEROUTER_API_KEY",
      baseUrl: env.providers.jerouter.baseUrl,
      apiKey: env.providers.jerouter.apiKey,
      proxyPool: proxyFor("jerouter"),
    }),
    new OpenAiCompatibleProvider({
      id: "madefaka",
      label: "Madefaka",
      credentialEnvVar: "MADEFAKA_API_KEY",
      baseUrl: env.providers.madefaka.baseUrl,
      apiKey: env.providers.madefaka.apiKey,
      proxyPool: proxyFor("madefaka"),
    }),
  ];
}

/** Ids an operator may not claim: they already mean something in this deployment. */
const RESERVED_IDS = new Set(builtins().map((provider) => provider.id));

export function isReservedProviderId(id: string): boolean {
  return RESERVED_IDS.has(id);
}

export function reservedProviderIds(): string[] {
  return [...RESERVED_IDS].sort();
}

/** Shape of the `provider_configs` fields this module needs. */
export interface CustomProviderRow {
  provider: string;
  label: string;
  baseUrl: string | null;
  kind: string;
  apiKeyCipher: string | null;
  extraHeaders: string;
  /** False when the row only annotates a builtin — it contributes settings, not an adapter. */
  custom: boolean;
  enabled: boolean;
  /** Sealed newline-separated proxy list, or null for direct egress. */
  proxyCipher: string | null;
}

/**
 * Live proxy pools, keyed by provider id and kept across snapshot refreshes.
 *
 * `ProxyAgent` owns a connection pool, so rebuilding one every time the 30-second registry
 * cache expires would throw away every keep-alive CONNECT tunnel. The cipher is the cache key:
 * it changes exactly when an operator edits the proxy list, which is also when the old agents
 * genuinely have to go.
 */
const livePools = new Map<string, { cipher: string; pool: ProxyPool }>();

/**
 * Resolves the pool for one provider, reusing the existing agents when the sealed list has not
 * changed.
 *
 * A list that will not open — credential key rotated, row tampered with — yields no pool rather
 * than an error. Egress then leaves from the deployment's own IP, exactly as it does for a
 * provider with no proxy configured; taking the upstream offline instead would turn a
 * misconfigured convenience feature into an outage.
 */
function poolFor(providerId: string, cipher: string | null): ProxyPool | null {
  const existing = livePools.get(providerId);
  if (existing && existing.cipher === cipher) return existing.pool;

  // Graceful: undici's close() resolves once in-flight requests on those sockets finish.
  if (existing) {
    livePools.delete(providerId);
    void existing.pool.close();
  }
  if (!cipher) return null;

  let proxies: ParsedProxy[] = [];
  try {
    proxies = parseProxyList(openSecret(cipher)).proxies;
  } catch {
    return null;
  }
  if (proxies.length === 0) return null;

  const pool = new ProxyPool(proxies);
  livePools.set(providerId, { cipher, pool });
  return pool;
}

/** Drops pools for providers that no longer configure one. */
function retireUnusedPools(active: Set<string>): void {
  for (const [providerId, entry] of livePools) {
    if (active.has(providerId)) continue;
    livePools.delete(providerId);
    void entry.pool.close();
  }
}

/**
 * Parses the stored extra-header JSON, dropping anything that is not a string→string pair.
 *
 * Deliberately forgiving: a malformed value costs the operator their custom headers, not the
 * whole provider. Header names that would let a row override the credential or the body
 * framing are refused — a stored `authorization` would otherwise silently replace the key the
 * adapter just decrypted.
 */
const PROTECTED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "content-type",
  "content-length",
  "accept",
  "anthropic-version",
  "host",
]);

export function parseExtraHeaders(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const key = name.trim().toLowerCase();
    if (key.length === 0 || PROTECTED_HEADERS.has(key)) continue;
    // No control characters or newlines: those are header-injection primitives.
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) continue;
    if (typeof value !== "string" || /[\r\n]/.test(value)) continue;
    headers[key] = value;
  }
  return headers;
}

/** Default base URL for a custom row that did not supply one. */
function defaultBaseUrl(kind: ProviderKind): string {
  return kind === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
}

/**
 * Builds a live provider from a stored row. `credentialEnvVar` is deliberately `""`: there is
 * no env var to point an operator at, and the adapters phrase their errors accordingly.
 *
 * A credential that will not open (key rotated, row tampered with) yields a provider with an
 * empty key rather than a throw. That resolves to `isConfigured() === false`, so the gateway
 * answers with the same `provider_unconfigured` 503 it already had, and the admin panel
 * reports the reason via `problems` — no new failure path anywhere else.
 */
export function providerFromRow(
  row: CustomProviderRow,
  proxyPool: ProxyPool | null = null,
): {
  provider: ModelProvider;
  problem?: string;
} {
  const kind: ProviderKind = isProviderKind(row.kind) ? row.kind : "openai";
  const baseUrl = row.baseUrl?.trim() || defaultBaseUrl(kind);
  const extraHeaders = parseExtraHeaders(row.extraHeaders);

  let apiKey = "";
  let problem: string | undefined;
  if (row.apiKeyCipher) {
    try {
      apiKey = openSecret(row.apiKeyCipher);
    } catch (error) {
      problem =
        error instanceof SecretBoxError
          ? error.message
          : "Stored credential could not be decrypted.";
    }
  } else {
    problem = "No API key is stored for this provider.";
  }

  const options = {
    id: row.provider,
    label: row.label,
    credentialEnvVar: "",
    baseUrl,
    apiKey,
    ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    ...(proxyPool ? { proxyPool } : {}),
  };

  const provider =
    kind === "anthropic"
      ? new AnthropicProvider(options)
      : new OpenAiCompatibleProvider(options);
  return problem ? { provider, problem } : { provider };
}

interface Snapshot {
  providers: Map<string, ModelProvider>;
  /** provider id → operator-facing reason it is not usable. Surfaced in Admin → Providers. */
  problems: Map<string, string>;
  /** ids that came from the database rather than env. */
  customIds: Set<string>;
  /** provider id → how many outbound proxies its traffic rotates through. */
  proxyCounts: Map<string, number>;
  loadedAt: number;
}

let snapshot: Snapshot | null = null;
let inFlight: Promise<Snapshot> | null = null;

/** Drops the cache. Call after any write to `provider_configs`. */
export function invalidateProviderCache(): void {
  snapshot = null;
  inFlight = null;
}

async function loadSnapshot(): Promise<Snapshot> {
  const providers = new Map<string, ModelProvider>();
  const problems = new Map<string, string>();
  const customIds = new Set<string>();
  const proxyCounts = new Map<string, number>();

  let rows: CustomProviderRow[] = [];
  try {
    // Two kinds of row matter here: a routable custom provider, and a builtin's annotation row
    // that carries nothing but a proxy list. The second is why the filter is an OR — a builtin
    // like `madefaka` has `custom: false`, so the old `custom: true` filter could never have
    // found its proxies.
    rows = await prisma.providerConfig.findMany({
      where: { OR: [{ custom: true, enabled: true }, { proxyCipher: { not: null } }] },
      select: {
        provider: true,
        label: true,
        baseUrl: true,
        kind: true,
        apiKeyCipher: true,
        extraHeaders: true,
        custom: true,
        enabled: true,
        proxyCipher: true,
      },
      orderBy: { createdAt: "asc" },
    });
  } catch {
    // A registry that cannot read the database still has to serve builtin traffic — the
    // gateway's job does not depend on custom providers existing.
  }

  // Proxy pools first: a builtin's pool has to exist before `builtins()` constructs it, and a
  // disabled custom row must not keep a pool alive.
  const pools = new Map<string, ProxyPool>();
  for (const row of rows) {
    if (row.custom === true && row.enabled === false) continue;
    const pool = poolFor(row.provider, row.proxyCipher ?? null);
    if (!pool) continue;
    pools.set(row.provider, pool);
    proxyCounts.set(row.provider, pool.size);
  }
  retireUnusedPools(new Set(pools.keys()));

  for (const row of rows) {
    if (isReservedProviderId(row.provider)) continue;
    // An annotation row for an id that is not a builtin either: it configures no adapter.
    if (row.custom === false) continue;
    if (row.enabled === false) continue;
    const { provider, problem } = providerFromRow(row, pools.get(row.provider) ?? null);
    providers.set(provider.id, provider);
    customIds.add(provider.id);
    if (problem) problems.set(provider.id, problem);
  }

  // Builtins last so they overwrite any custom row that slipped past validation.
  for (const provider of builtins((id) => pools.get(id) ?? null)) {
    providers.set(provider.id, provider);
    customIds.delete(provider.id);
  }

  return { providers, problems, customIds, proxyCounts, loadedAt: Date.now() };
}

async function currentSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.loadedAt < CACHE_TTL_MS) return snapshot;
  // Concurrent gateway requests share one database read instead of stampeding it.
  inFlight ??= loadSnapshot()
    .then((loaded) => {
      snapshot = loaded;
      return loaded;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Resolves one provider by id, or null when nothing serves it. */
export async function resolveProvider(id: string): Promise<ModelProvider | null> {
  const { providers } = await currentSnapshot();
  return providers.get(id) ?? null;
}

/** Every provider this deployment can route to right now. */
export async function listProviders(): Promise<ModelProvider[]> {
  const { providers } = await currentSnapshot();
  return [...providers.values()];
}

/** True when `id` came from `provider_configs` rather than env. */
export async function isCustomProvider(id: string): Promise<boolean> {
  const { customIds } = await currentSnapshot();
  return customIds.has(id);
}

/**
 * Provider status for the admin panel. Only non-secret facts are returned — the credential
 * value itself never leaves this process.
 */
export interface ProviderStatus {
  id: string;
  label: string;
  /** "" for a custom provider: its credential is in the database, not the environment. */
  credentialEnvVar: string;
  configured: boolean;
  custom: boolean;
  /** How many outbound proxies this upstream's traffic rotates through. 0 means direct. */
  proxies: number;
  health: HealthStatus;
}

export async function providerStatuses(probe = false): Promise<ProviderStatus[]> {
  const { providers, problems, customIds, proxyCounts } = await currentSnapshot();
  return Promise.all(
    [...providers.values()].map(async (provider) => {
      const configured = provider.isConfigured();
      const problem = problems.get(provider.id);
      return {
        id: provider.id,
        label: provider.label,
        credentialEnvVar: provider.credentialEnvVar,
        configured,
        custom: customIds.has(provider.id),
        proxies: proxyCounts.get(provider.id) ?? 0,
        health:
          probe && configured
            ? await provider.healthCheck()
            : configured
              ? { state: "ok" as const, detail: "Credential present (not probed)." }
              : {
                  state: "unconfigured" as const,
                  detail:
                    problem ??
                    (provider.credentialEnvVar
                      ? `${provider.credentialEnvVar} is not set.`
                      : "No API key is stored for this provider."),
                },
      };
    }),
  );
}
