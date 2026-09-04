import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Content-Security-Policy. Next.js needs 'unsafe-inline' for its bootstrap style
 * attributes; in development it additionally needs 'unsafe-eval' for HMR.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // `qrcode` is CommonJS and only ever runs server-side (QRIS symbols are encoded in
  // `src/lib/payments/qr.ts` and shipped to the browser as an SVG path, never as a library).
  // `undici` is server-only too: it is bundled purely so a provider's outbound proxy pool can
  // dispatch through `ProxyAgent`, which Node's built-in fetch refuses to accept.
  serverExternalPackages: ["better-sqlite3", "pg", "qrcode", "undici"],
  experimental: {
    /**
     * Client router cache. `dynamic` defaults to 0 in Next 15+, so returning to a dashboard
     * page you just left re-rendered it on the server from scratch. Thirty seconds is short
     * enough that quota and usage figures stay current within a session, while making
     * back-and-forth navigation between pages instant. `static` (>= 30s required) covers
     * prefetched loading boundaries.
     */
    staleTimes: { dynamic: 30, static: 180 },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          ...(isProd
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]
            : []),
        ],
      },
      {
        // The gateway API is Bearer-authenticated and intended for cross-origin SDK use.
        source: "/v1/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          {
            key: "Access-Control-Allow-Headers",
            value: "Authorization,Content-Type,x-api-key,anthropic-version",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
