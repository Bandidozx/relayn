/**
 * Server-only environment access. Never import from a client component.
 *
 * Provider credentials are read here and stay on the server: nothing in this module
 * is ever serialised into a payload sent to the browser.
 */
import "server-only";

function str(name: string, fallback = ""): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function int(name: string, fallback: number): number {
  const parsed = Number.parseInt(str(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback = false): boolean {
  const raw = str(name).toLowerCase();
  if (raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

export const isProduction = process.env.NODE_ENV === "production";
export const isTest = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);

export const env = {
  databaseUrl: str("DATABASE_URL", "file:./dev.db"),
  appUrl: str("APP_URL", "http://localhost:3200").replace(/\/$/, ""),
  sessionSecret: str("SESSION_SECRET"),
  /**
   * 32 bytes as 64 hex characters, encrypting the provider credentials an operator adds from
   * Admin → Providers (see `lib/security/secret-box`). Optional: when unset the key is derived
   * from `SESSION_SECRET`, which works but couples the two — rotating `SESSION_SECRET` then
   * makes stored provider credentials unopenable and they have to be re-entered. Set this in
   * production so the two secrets can rotate independently.
   */
  providerCredentialKey: str("PROVIDER_CREDENTIAL_KEY"),
  sessionTtlDays: int("SESSION_TTL_DAYS", 7),
  rateLimitPerMinute: int("RATE_LIMIT_PER_MINUTE", 60),
  rateLimitAuthPerMinute: int("RATE_LIMIT_AUTH_PER_MINUTE", 10),
  enableMockProvider: bool("ENABLE_MOCK_PROVIDER", !isProduction),
  emailTransport: str("EMAIL_TRANSPORT", "log"),
  emailFrom: str("EMAIL_FROM", "no-reply@relayn.dev"),
  /**
   * Identity providers for dashboard sign-in. Distinct from `providers.google` below,
   * which is a *model* credential for Gemini — these two have nothing to do with each
   * other and must not be conflated in configuration.
   */
  oauth: {
    google: {
      clientId: str("GOOGLE_OAUTH_CLIENT_ID"),
      clientSecret: str("GOOGLE_OAUTH_CLIENT_SECRET"),
    },
  },
  /**
   * One-time payment for permanent unlimited access. Two independent rails live here:
   * `tripay` (QRIS, currently paused) and `crypto` (an on-chain transfer the server verifies
   * itself). Neither holds a value that is ever returned by an API route, rendered into a
   * page, or written to a log — readiness is reported as a boolean instead.
   *
   * `apiKey` authenticates our outbound calls; `privateKey` is the HMAC secret the provider
   * signs callbacks with.
   */
  payments: {
    /** Registry id of the active PaymentProvider. Only "tripay" has an adapter today. */
    provider: str("PAYMENT_PROVIDER", "tripay"),
    tripay: {
      apiKey: str("TRIPAY_API_KEY"),
      privateKey: str("TRIPAY_PRIVATE_KEY"),
      merchantCode: str("TRIPAY_MERCHANT_CODE"),
      /** "sandbox" | "production" — selects the default base URL. */
      mode: str("TRIPAY_MODE", "sandbox"),
      /** Overrides the mode-derived base URL. Rarely needed. */
      baseUrl: str("TRIPAY_BASE_URL"),
      /** Channel code. QRIS is the only one this deployment offers. */
      method: str("TRIPAY_PAYMENT_METHOD", "QRIS"),
    },
    /**
     * One-time crypto payment for permanent unlimited access.
     *
     * Note what is *absent*: there is no private key and no signing credential of any kind.
     * Relayn only ever **reads** the chain, so the receiving wallet's key stays wherever the
     * operator keeps it and is never needed here. `address` is a public receiving address and
     * is deliberately the one payment value the browser is allowed to see.
     *
     * `amount` is a decimal string in whole units of the asset ("0.10"), converted to base
     * units with exact integer arithmetic — never a float, and never a market rate looked up
     * at request time. For a stablecoin that makes $0.10 a fixed `100000` base units.
     */
    crypto: {
      /** Chain slug. Must name an entry in `EVM_NETWORKS`; "" disables crypto payments. */
      network: str("CRYPTO_PAYMENT_NETWORK"),
      /** Display symbol of the accepted asset. One asset only, by design. */
      asset: str("CRYPTO_PAYMENT_ASSET", "USDC"),
      /** ERC-20 contract of the accepted asset. Defaults to native USDC on a known network. */
      tokenAddress: str("CRYPTO_PAYMENT_TOKEN_ADDRESS"),
      /** Decimals of the accepted asset. USDC is 6 on every chain Circle issues it on. */
      assetDecimals: int("CRYPTO_PAYMENT_ASSET_DECIMALS", 6),
      /** Public receiving address. Rendered to the payer; holds no authority here. */
      address: str("CRYPTO_PAYMENT_ADDRESS"),
      /** Price in whole units of the asset, as a decimal string. "0.10" = $0.10 in USDC. */
      amount: str("CRYPTO_PAYMENT_AMOUNT", "0.10"),
      /** JSON-RPC endpoint. The primary source of truth; falls back to the network default. */
      rpcUrl: str("CRYPTO_PAYMENT_RPC_URL"),
      /** Confirmations required before a transfer counts. Base blocks are ~2s. */
      minConfirmations: int("CRYPTO_PAYMENT_MIN_CONFIRMATIONS", 3),
      /**
       * How old a transaction may be and still be claimable, in hours. 0 disables the check.
       * Stops an unrelated historical transfer to the receiving address from being claimed by
       * whoever spots it in the explorer first.
       */
      maxAgeHours: int("CRYPTO_PAYMENT_MAX_AGE_HOURS", 24),
      /** Optional read-only explorer base URL, used for the payer's "view transaction" link. */
      explorerUrl: str("CRYPTO_PAYMENT_EXPLORER_URL"),
    },
  },
  providers: {
    openai: {
      apiKey: str("OPENAI_API_KEY"),
      baseUrl: str("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    },
    anthropic: {
      apiKey: str("ANTHROPIC_API_KEY"),
      baseUrl: str("ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1"),
    },
    google: {
      apiKey: str("GOOGLE_API_KEY"),
      baseUrl: str("GOOGLE_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai"),
    },
    openrouter: {
      apiKey: str("OPENROUTER_API_KEY"),
      baseUrl: str("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    },
    // Two OpenAI-compatible aggregators. They speak the same dialect as the entries above,
    // so they need no adapter of their own — only a base URL and a credential. Both are
    // catalogue-synced (`npm run models:sync`) rather than hand-seeded, because what they
    // serve changes without notice.
    jerouter: {
      apiKey: str("JEROUTER_API_KEY"),
      baseUrl: str("JEROUTER_BASE_URL", "https://jerouter.web.id/v1"),
    },
    madefaka: {
      apiKey: str("MADEFAKA_API_KEY"),
      baseUrl: str("MADEFAKA_BASE_URL", "https://api.madefaka.my.id/v1"),
    },
  },
} as const;

/**
 * Fails fast in production when a secret is missing rather than silently falling back
 * to a development value.
 */
export function assertRuntimeSecrets(): void {
  if (!isProduction) return;
  if (env.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters in production.");
  }
}

/** Development fallback so the app boots before an operator sets SESSION_SECRET. */
export function sessionSecret(): string {
  if (env.sessionSecret.length >= 32) return env.sessionSecret;
  if (isProduction) {
    throw new Error("SESSION_SECRET is missing. Refusing to sign sessions with a default.");
  }
  return "relayn-development-session-secret-do-not-use-in-production";
}
