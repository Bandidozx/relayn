import type { Metadata } from "next";
import Link from "next/link";
import { KeysManager } from "@/components/keys/keys-manager";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { planOf } from "@/lib/plans";
import { getRequestSubscription } from "@/lib/usage/accounting";
import { listApiKeys } from "@/server/services/keys-service";

export const metadata: Metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  const { user } = await requireUser();
  const [keys, subscription] = await Promise.all([
    listApiKeys(user.id),
    getRequestSubscription(user.id),
  ]);
  const plan = planOf(subscription.plan);

  return (
    <>
      <PageHeader
        title="API keys"
        description="One key authenticates every model your plan allows. Keys are stored as SHA-256 hashes — we can show you a new key once, never an old one."
      />

      <KeysManager initialKeys={keys} planName={plan.name} maxKeys={plan.maxApiKeys} />

      <Card>
        <CardHeader
          title="Using a key"
          description="Send it as a bearer token to the OpenAI-compatible endpoint."
          action={
            <Link
              href="/integrations"
              className="text-[11px] text-brand transition-opacity hover:opacity-80"
            >
              Full examples →
            </Link>
          }
        />
        <CardBody className="space-y-2 text-xs leading-relaxed text-ink-muted">
          <p>
            Pass the key in the <span className="numeric text-ink">Authorization</span> header of
            every request: <span className="numeric text-ink">Authorization: Bearer rly_live_…</span>
          </p>
          <ul className="list-inside list-disc space-y-1">
            <li>Keys are per-account. Usage from any key counts against the same allocation.</li>
            <li>Revoking is immediate — the gateway checks key status on every request.</li>
            <li>
              Store keys in environment variables or a secrets manager. Never commit them or ship
              them to a browser.
            </li>
          </ul>
        </CardBody>
      </Card>
    </>
  );
}
