/**
 * Outbound proxy pool for upstream provider traffic.
 *
 * Why this exists: every request Relayn makes to an upstream leaves from the deployment's own
 * egress IP, so all of an operator's traffic to a reseller gateway shares one address and one
 * per-IP rate-limit bucket. Routing a provider's calls through one or more forward proxies
 * spreads that traffic, and also covers the mundane cases — an upstream that allowlists egress
 * IPs, or a network that requires a corporate proxy.
 *
 * Worth being straight about the limits: if the upstream's limit is per *account* rather than
 * per IP, proxies change nothing, and rotating IPs specifically to get around a provider's
 * published limits may well breach its terms. The robust fix for capacity failures is the
 * fallback chain on `models.fallbacks` plus more upstream accounts. This module is the
 * transport knob, not a licence.
 *
 * ## Why undici's fetch and not the global one
 *
 * Node's global `fetch` is its own bundled copy of undici and rejects a dispatcher built by the
 * separately-installed `undici` package — it fails with `UND_ERR_INVALID_ARG` rather than
 * proxying (verified empirically, not assumed). So a proxied call has to go through the npm
 * package's own `fetch`, which accepts the dispatcher it created.
 *
 * Unproxied calls deliberately keep using the global `fetch`. That path is already in
 * production and verified; there is no reason to move every upstream call onto a different HTTP
 * stack to add an opt-in feature.
 */
import "server-only";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { type ParsedProxy } from "@/lib/providers/proxy-format";

/**
 * Parsing, redaction and the list cap live in `proxy-format` so the admin form can share them —
 * this module cannot be imported from a client bundle (`server-only`, and `undici` above). They
 * are re-exported here so every existing server importer keeps working unchanged.
 */
export {
  MAX_PROXIES_PER_PROVIDER,
  parseProxyList,
  parseProxyUrl,
  proxyHintFor,
  redact,
  type ParsedProxy,
} from "@/lib/providers/proxy-format";

/** How long a pool entry stays parked after a connection-level failure. */
const COOLDOWN_MS = 60_000;

interface PoolEntry {
  proxy: ParsedProxy;
  agent: ProxyAgent;
  /** Epoch ms until which this entry is skipped after a transport failure. */
  cooldownUntil: number;
}

/**
 * A provider's proxies, with round-robin selection and a short cooldown on failure.
 *
 * Agents are built once and reused: `ProxyAgent` owns a connection pool, so constructing one
 * per request would throw away keep-alive and open a fresh CONNECT tunnel every call.
 */
export class ProxyPool {
  private readonly entries: PoolEntry[];
  private cursor = 0;

  constructor(proxies: ParsedProxy[]) {
    this.entries = proxies.map((proxy) => ({
      proxy,
      agent: new ProxyAgent({ uri: proxy.url }),
      cooldownUntil: 0,
    }));
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Next usable entry, or null when the pool is empty. When every entry is cooling down the
   * least-recently-failed one is returned anyway: a stale cooldown must not turn "all proxies
   * had a blip" into "this provider is unreachable".
   */
  next(): PoolEntry | null {
    if (this.entries.length === 0) return null;
    const now = Date.now();

    for (let attempt = 0; attempt < this.entries.length; attempt += 1) {
      const entry = this.entries[this.cursor % this.entries.length]!;
      this.cursor = (this.cursor + 1) % this.entries.length;
      if (entry.cooldownUntil <= now) return entry;
    }

    return this.entries.reduce((oldest, entry) =>
      entry.cooldownUntil < oldest.cooldownUntil ? entry : oldest,
    );
  }

  /** Parks an entry after a connection-level failure so the next call skips it. */
  penalise(entry: PoolEntry): void {
    entry.cooldownUntil = Date.now() + COOLDOWN_MS;
  }

  /** Releases sockets. Called when a provider's config changes and the pool is replaced. */
  async close(): Promise<void> {
    await Promise.allSettled(this.entries.map((entry) => entry.agent.close()));
  }
}

export interface ProxiedFetchResult {
  response: Response;
  /** `host:port` of the proxy used, or null when the call went out directly. */
  via: string | null;
}

/**
 * Performs `fetch` through a pool, retrying the next proxy once on a transport failure.
 *
 * Only connection-level failures rotate. An HTTP response is returned as-is even when it is a
 * 429: deciding what an upstream status means belongs to the provider adapter, and retrying a
 * 429 here would silently double-charge the operator's upstream quota.
 */
export async function fetchThroughPool(
  url: string,
  init: RequestInit,
  pool: ProxyPool | null,
): Promise<ProxiedFetchResult> {
  if (!pool || pool.size === 0) {
    return { response: await fetch(url, init), via: null };
  }

  let lastError: unknown = null;
  const attempts = Math.min(2, pool.size);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const entry = pool.next();
    if (!entry) break;
    try {
      // Cast at the boundary: undici's Response is the same web Response this runtime
      // implements, but the package ships its own structural type.
      const response = (await undiciFetch(url, {
        ...(init as Record<string, unknown>),
        dispatcher: entry.agent,
      } as never)) as unknown as Response;
      return { response, via: entry.proxy.origin };
    } catch (error) {
      // An abort is the caller's timeout or disconnect, not the proxy's fault — rotating
      // would burn a second proxy on a request that is already over.
      if (error instanceof Error && error.name === "AbortError") throw error;
      lastError = error;
      pool.penalise(entry);
    }
  }

  throw lastError ?? new Error("All configured proxies failed.");
}
