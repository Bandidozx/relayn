/**
 * Proxy-list parsing and display, with no transport dependencies.
 *
 * Split out of `lib/providers/proxy` on purpose: that module imports `undici` and is
 * `server-only`, so the admin form could not reuse its parser and would have had to reimplement
 * the accepted-URL rule in the browser. A second implementation is exactly how a client stops
 * agreeing with its server — a paste the form accepts but the API rejects, or worse the reverse.
 * Everything here is pure string work, safe in both bundles, and `lib/providers/proxy` re-exports
 * it so existing server importers are unchanged.
 *
 * The client uses it to preview and count a pasted list; the server still parses again on save
 * and remains the enforcement point.
 */

/** Bounded so a pasted file cannot turn into an unbounded agent pool. */
export const MAX_PROXIES_PER_PROVIDER = 20;

export interface ParsedProxy {
  /** Normalised absolute URL, credentials included. This is the value that gets sealed. */
  url: string;
  /** `host:port`, for logs and hints. Never carries the password. */
  origin: string;
}

/**
 * Accepts one proxy URL and normalises it, or explains why it is unusable.
 *
 * `http://`, `https://`, `socks4://`, `socks5://` and `socks5h://` are all recognised so the
 * message can name the real problem, but only the HTTP schemes can be dispatched — undici's
 * `ProxyAgent` speaks HTTP CONNECT and has no SOCKS transport. A SOCKS entry is therefore
 * rejected here with that reason rather than accepted and then quietly ignored at request time.
 */
export function parseProxyUrl(raw: string): { proxy: ParsedProxy } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { error: "Proxy URL is empty." };
  if (/[\r\n\s]/.test(trimmed)) return { error: "Proxy URL contains whitespace." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `\`${redact(trimmed)}\` is not a valid URL. Expected http://user:pass@host:port.` };
  }

  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  if (scheme === "socks4" || scheme === "socks5" || scheme === "socks5h") {
    return {
      error: `SOCKS proxies are not supported (${redact(trimmed)}). Use an http:// or https:// forward proxy.`,
    };
  }
  if (scheme !== "http" && scheme !== "https") {
    return { error: `Unsupported proxy scheme \`${scheme}\`. Use http:// or https://.` };
  }
  if (!parsed.hostname) return { error: "Proxy URL has no host." };
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { error: `A proxy URL must not carry a path (${redact(trimmed)}).` };
  }

  return {
    proxy: {
      url: parsed.toString(),
      origin: `${parsed.hostname}:${parsed.port || (scheme === "https" ? "443" : "80")}`,
    },
  };
}

/** Replaces any password in a proxy URL with `***`, for messages and hints. */
export function redact(raw: string): string {
  return raw.replace(/(\/\/[^:/@]*):[^@/]*@/, "$1:***@");
}

/**
 * Parses a newline- or comma-separated proxy list. Returns the usable entries and one error
 * line per rejected entry, so the admin form can accept a pasted list and report exactly which
 * lines were dropped instead of failing the whole save.
 */
export function parseProxyList(raw: string): { proxies: ParsedProxy[]; errors: string[] } {
  const entries = raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const proxies: ParsedProxy[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries.slice(0, MAX_PROXIES_PER_PROVIDER)) {
    const result = parseProxyUrl(entry);
    if ("error" in result) {
      errors.push(result.error);
      continue;
    }
    if (seen.has(result.proxy.url)) continue;
    seen.add(result.proxy.url);
    proxies.push(result.proxy);
  }
  if (entries.length > MAX_PROXIES_PER_PROVIDER) {
    errors.push(
      `Only the first ${MAX_PROXIES_PER_PROVIDER} proxies were kept; ${entries.length - MAX_PROXIES_PER_PROVIDER} more were ignored.`,
    );
  }

  return { proxies, errors };
}

/**
 * Display form for a stored list: the first entry with its password removed, plus a count.
 * This is what the admin API returns — the sealed list itself never leaves the server.
 */
export function proxyHintFor(proxies: ParsedProxy[]): string {
  if (proxies.length === 0) return "";
  const first = redact(proxies[0]!.url);
  return proxies.length === 1 ? first : `${first} +${proxies.length - 1} more`;
}
