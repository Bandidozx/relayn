/**
 * Crypto payment registry.
 *
 * Mirrors `src/lib/payments/registry.ts` in shape and purpose: one lookup point, so adding a
 * second chain family (a Solana adapter, say) is a new file plus an entry here rather than a
 * change to the service or the route.
 *
 * Unlike the fiat registry this one resolves to `null` rather than throwing when the
 * deployment is not configured. Crypto payments are opt-in per deployment — a dev machine with
 * no `CRYPTO_PAYMENT_*` variables set must still render the subscription page, and it does so
 * by being told the purchase is unavailable rather than by catching an exception.
 */
import "server-only";
import { evmConfigFromEnv, evmExpectation, createEvmProvider, type EvmConfig } from "@/lib/payments/crypto/evm";
import type { CryptoExpectation } from "@/lib/payments/crypto/rules";
import type { CryptoPaymentProvider } from "@/lib/payments/crypto/types";

interface ActiveCrypto {
  provider: CryptoPaymentProvider;
  config: EvmConfig;
  expectation: CryptoExpectation;
}

/**
 * Resolved once per process. The configuration is read from `process.env`, which does not
 * change under a running server, and building it involves address validation and exact decimal
 * arithmetic that there is no reason to repeat on every request.
 */
let cached: ActiveCrypto | null | undefined;

export function activeCrypto(): ActiveCrypto | null {
  if (cached !== undefined) return cached;
  const config = evmConfigFromEnv();
  cached = config
    ? { provider: createEvmProvider(config), config, expectation: evmExpectation(config) }
    : null;
  return cached;
}

/** True when a crypto payment can actually be verified right now. */
export function cryptoPaymentsConfigured(): boolean {
  return activeCrypto() !== null;
}

/** Readiness for the dashboard: booleans and env var names, never a configured value. */
export interface CryptoPaymentStatus {
  adapter: string;
  configured: boolean;
  credentialEnvVars: readonly string[];
}

export function cryptoPaymentStatus(): CryptoPaymentStatus {
  const active = activeCrypto();
  return {
    adapter: active?.provider.id ?? "evm-erc20",
    configured: active !== null,
    credentialEnvVars: [
      "CRYPTO_PAYMENT_NETWORK",
      "CRYPTO_PAYMENT_ASSET",
      "CRYPTO_PAYMENT_ADDRESS",
      "CRYPTO_PAYMENT_AMOUNT",
    ],
  };
}

/** Test hook: the resolved configuration is process-local state. */
export function __resetCryptoRegistry(): void {
  cached = undefined;
}
