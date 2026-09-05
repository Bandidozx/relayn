import type { Metadata } from "next";
import Link from "next/link";
import { IntegrationsWorkbench, type KeyOption } from "@/components/integrations/integrations-workbench";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { listApiKeys } from "@/server/services/keys-service";
import { listIntegrations } from "@/server/services/integrations-service";
import { listModelsForUser } from "@/server/services/models-service";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  const { user } = await requireUser();
  const [catalogue, keys, integrations] = await Promise.all([
    listModelsForUser(user),
    listApiKeys(user.id),
    listIntegrations(user.id),
  ]);

  const models = catalogue.models.filter((model) => model.available).map((model) => model.modelId);
  const keyOptions: KeyOption[] = keys.map((key) => ({
    id: key.id,
    name: key.name,
    last4: key.last4,
    status: key.status,
  }));
  const hasActiveKey = keys.some((key) => key.status === "active");

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Drop-in examples for every client we support. Change the base URL, keep your existing code."
        action={
          <Link
            href="/docs"
            className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          >
            Full API reference
          </Link>
        }
      />

      {hasActiveKey ? null : (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink-muted">
              You do not have an active API key yet, so these snippets will fail with{" "}
              <span className="numeric text-ink">401 invalid_api_key</span> until you create one.
            </p>
            <Link
              href="/api-keys"
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-ink transition-opacity hover:opacity-90"
            >
              Create a key
            </Link>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Endpoint"
          description="Point any OpenAI-compatible client at this base URL."
        />
        <CardBody className="grid gap-3 text-xs sm:grid-cols-3">
          <div className="rounded-xl border border-line bg-canvas px-3 py-2.5">
            <p className="text-[10.5px] tracking-wide text-ink-faint uppercase">Base URL</p>
            <p className="numeric mt-1 break-all text-ink">{env.appUrl}/v1</p>
          </div>
          <div className="rounded-xl border border-line bg-canvas px-3 py-2.5">
            <p className="text-[10.5px] tracking-wide text-ink-faint uppercase">Auth header</p>
            <p className="numeric mt-1 break-all text-ink">Authorization: Bearer rly_live_…</p>
          </div>
          <div className="rounded-xl border border-line bg-canvas px-3 py-2.5">
            <p className="text-[10.5px] tracking-wide text-ink-faint uppercase">Endpoints</p>
            <p className="numeric mt-1 break-all text-ink">
              /v1/chat/completions · /v1/models · /v1/messages
            </p>
          </div>
        </CardBody>
      </Card>

      <IntegrationsWorkbench
        baseUrl={env.appUrl}
        models={models}
        keys={keyOptions}
        initialIntegrations={integrations}
      />
    </>
  );
}
