/**
 * Payment provider registry.
 *
 * Mirrors `src/lib/providers/registry.ts`. `PAYMENT_PROVIDER` names the active adapter, so
 * swapping TriPay for another processor is one new file plus one env var — no route or service
 * change. Only "tripay" has an adapter today.
 */
import "server-only";
import { env } from "@/lib/env";
import { tripayFromEnv } from "@/lib/payments/tripay";
import type { PaymentProvider } from "@/lib/payments/types";

function build(): Map<string, PaymentProvider> {
  const providers: PaymentProvider[] = [tripayFromEnv()];
  return new Map(providers.map((provider) => [provider.id, provider]));
}

const registry = build();

export function getPaymentProvider(id: string): PaymentProvider | null {
  return registry.get(id) ?? null;
}

export function listPaymentProviders(): PaymentProvider[] {
  return [...registry.values()];
}

/**
 * The adapter this deployment charges through. Throws only when `PAYMENT_PROVIDER` names
 * something that has no adapter, which is an operator misconfiguration rather than a
 * runtime condition — an *unconfigured* provider still resolves, and reports
 * `isConfigured() === false` so the UI can say so instead of 500ing.
 */
export function activePaymentProvider(): PaymentProvider {
  const id = env.payments.provider;
  const provider = getPaymentProvider(id);
  if (!provider) {
    throw new Error(
      `PAYMENT_PROVIDER="${id}" has no adapter. Known providers: ${[...registry.keys()].join(", ")}.`,
    );
  }
  return provider;
}

/** Readiness for the dashboard: a boolean and env var names, never a credential value. */
export interface PaymentProviderStatus {
  id: string;
  label: string;
  credentialEnvVars: readonly string[];
  configured: boolean;
}

export function activePaymentStatus(): PaymentProviderStatus {
  const provider = activePaymentProvider();
  return {
    id: provider.id,
    label: provider.label,
    credentialEnvVars: provider.credentialEnvVars,
    configured: provider.isConfigured(),
  };
}

/** True when a checkout can actually be created right now. */
export function paymentsConfigured(): boolean {
  try {
    return activePaymentProvider().isConfigured();
  } catch {
    return false;
  }
}
