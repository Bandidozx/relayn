/**
 * Proxy-list parsing — the rule the admin form and the server must agree on.
 *
 * This parser is the only definition of what an operator may paste into a provider's egress
 * list, and it runs in both bundles (the browser previews the paste, the server enforces it), so
 * a disagreement here is a form that accepts something the API then refuses. Two properties
 * carry security weight and are asserted rather than assumed:
 *
 *   1. **A password never appears in output.** A proxy URL is a credential; every string this
 *      module produces for a human — error text and the stored hint alike — goes through
 *      `redact`, so a rejected line cannot leak the password by way of an error message.
 *   2. **SOCKS is rejected, not ignored.** `ProxyAgent` speaks HTTP CONNECT only. Accepting a
 *      `socks5://` entry would produce a pool that silently never dispatches through it.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PROXIES_PER_PROVIDER,
  parseProxyList,
  parseProxyUrl,
  proxyHintFor,
  redact,
} from "@/lib/providers/proxy-format";

/** Narrowing helper: these two shapes are a union, so a test must pick a side. */
function ok(result: ReturnType<typeof parseProxyUrl>) {
  if ("error" in result) throw new Error(`expected a proxy, got: ${result.error}`);
  return result.proxy;
}

function err(result: ReturnType<typeof parseProxyUrl>): string {
  if (!("error" in result)) throw new Error(`expected an error, got: ${result.proxy.url}`);
  return result.error;
}

describe("parseProxyUrl", () => {
  it("accepts an http proxy with credentials and keeps them in the sealed url", () => {
    const proxy = ok(parseProxyUrl("http://user:s3cret@gate.example:8080"));
    expect(proxy.url).toBe("http://user:s3cret@gate.example:8080/");
    expect(proxy.origin).toBe("gate.example:8080");
  });

  it("accepts https and fills in the scheme's default port for the origin", () => {
    expect(ok(parseProxyUrl("https://gate.example")).origin).toBe("gate.example:443");
    expect(ok(parseProxyUrl("http://gate.example")).origin).toBe("gate.example:80");
  });

  it("keeps the password out of `origin`, which is what logs and hints use", () => {
    const proxy = ok(parseProxyUrl("http://user:s3cret@gate.example:8080"));
    expect(proxy.origin).not.toContain("s3cret");
  });

  it("rejects SOCKS by naming the reason, because it cannot be dispatched", () => {
    const message = err(parseProxyUrl("socks5://gate.example:1080"));
    expect(message).toContain("SOCKS");
    for (const scheme of ["socks4", "socks5", "socks5h"]) {
      expect(err(parseProxyUrl(`${scheme}://gate.example:1080`))).toContain("SOCKS");
    }
  });

  it("rejects a scheme no forward proxy uses", () => {
    expect(err(parseProxyUrl("ftp://gate.example:21"))).toContain("Unsupported proxy scheme");
  });

  it("rejects a url carrying a path, which would be a request and not a proxy", () => {
    expect(err(parseProxyUrl("http://gate.example:8080/v1"))).toContain("must not carry a path");
  });

  it("rejects empty, whitespace-bearing and unparseable input", () => {
    expect(err(parseProxyUrl("   "))).toBe("Proxy URL is empty.");
    expect(err(parseProxyUrl("http://a b.example:8080"))).toContain("whitespace");
    expect(err(parseProxyUrl("http://"))).toContain("is not a valid URL");
    // A bare `host:port` is a *parseable* URL — `gate.example:` reads as the scheme — so it is
    // refused by the scheme check rather than the parse. Either way it never reaches a pool.
    expect(err(parseProxyUrl("gate.example:8080"))).toContain("Unsupported proxy scheme");
  });

  it("never repeats a password back in an error message", () => {
    // The most likely leak: a bad line is echoed verbatim into the text a human reads.
    for (const bad of [
      "socks5://user:s3cret@gate.example:1080",
      "ftp://user:s3cret@gate.example:21",
      "http://user:s3cret@gate.example:8080/path",
      "http://user:s3cret@:8080",
    ]) {
      expect(err(parseProxyUrl(bad))).not.toContain("s3cret");
    }
  });
});

describe("redact", () => {
  it("replaces only the password", () => {
    expect(redact("http://user:s3cret@gate.example:8080")).toBe("http://user:***@gate.example:8080");
  });

  it("leaves a url without credentials untouched", () => {
    expect(redact("http://gate.example:8080")).toBe("http://gate.example:8080");
  });
});

describe("parseProxyList", () => {
  it("splits on newlines and commas, and ignores blank lines and # comments", () => {
    const { proxies, errors } = parseProxyList(
      ["# egress pool", "http://a.example:8080, http://b.example:8080", "", "http://c.example:8080"].join("\n"),
    );
    expect(proxies.map((entry) => entry.origin)).toEqual([
      "a.example:8080",
      "b.example:8080",
      "c.example:8080",
    ]);
    expect(errors).toEqual([]);
  });

  it("keeps the good lines and reports the bad ones instead of failing the paste", () => {
    const { proxies, errors } = parseProxyList(
      ["http://a.example:8080", "socks5://b.example:1080", "http://c.example:8080"].join("\n"),
    );
    expect(proxies.map((entry) => entry.origin)).toEqual(["a.example:8080", "c.example:8080"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("SOCKS");
  });

  it("drops exact duplicates silently — a repeated line is not an error", () => {
    const { proxies, errors } = parseProxyList("http://a.example:8080\nhttp://a.example:8080");
    expect(proxies).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("treats the same host with different credentials as two proxies", () => {
    // Two upstream accounts behind one gateway host is a real arrangement, so the URL is the
    // identity here, not the origin.
    const { proxies } = parseProxyList(
      "http://one:p1@a.example:8080\nhttp://two:p2@a.example:8080",
    );
    expect(proxies).toHaveLength(2);
  });

  it("caps the list and says how many were dropped", () => {
    const over = MAX_PROXIES_PER_PROVIDER + 3;
    const raw = Array.from({ length: over }, (_, index) => `http://p${index}.example:8080`).join("\n");
    const { proxies, errors } = parseProxyList(raw);
    expect(proxies).toHaveLength(MAX_PROXIES_PER_PROVIDER);
    expect(errors.join(" ")).toContain(`${over - MAX_PROXIES_PER_PROVIDER} more were ignored`);
  });

  it("returns nothing usable for a list where every line is bad", () => {
    // This is the shape the server turns into a 400 and the dialog refuses to submit.
    const { proxies, errors } = parseProxyList("socks5://a.example:1080\nnot-a-url");
    expect(proxies).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it("returns nothing and no errors for an empty list, which is how egress is cleared", () => {
    expect(parseProxyList("   \n\n")).toEqual({ proxies: [], errors: [] });
  });
});

describe("proxyHintFor", () => {
  it("is empty for no proxies", () => {
    expect(proxyHintFor([])).toBe("");
  });

  it("shows the first entry redacted, and counts the rest", () => {
    const { proxies } = parseProxyList(
      "http://user:s3cret@a.example:8080\nhttp://user:s3cret@b.example:8080",
    );
    const hint = proxyHintFor(proxies);
    expect(hint).toBe("http://user:***@a.example:8080/ +1 more");
    expect(hint).not.toContain("s3cret");
  });

  it("omits the count when there is only one", () => {
    const { proxies } = parseProxyList("http://a.example:8080");
    expect(proxyHintFor(proxies)).toBe("http://a.example:8080/");
  });
});
