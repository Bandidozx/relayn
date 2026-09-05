import type { Metadata } from "next";
import Link from "next/link";
import { ModelBrowser } from "@/components/models/model-browser";
import { StatCard, StatGrid } from "@/components/dashboard/stat-card";
import { PageHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireUser } from "@/lib/auth/guards";
import { formatNumber } from "@/lib/format";
import { listModelsForUser } from "@/server/services/models-service";

export const metadata: Metadata = { title: "Models" };

export default async function ModelsPage() {
  const { user } = await requireUser();
  const catalogue = await listModelsForUser(user.id);

  if (catalogue.models.length === 0) {
    return (
      <>
        <PageHeader title="Models" description="The catalogue available to your account." />
        <div className="panel">
          <EmptyState
            title="No models are enabled yet"
            description="An administrator has to enable models before they can be called. If you run this deployment, seed the catalogue with npm run db:seed."
          />
        </div>
      </>
    );
  }

  const locked = catalogue.models.length - catalogue.availableCount;

  return (
    <>
      <PageHeader
        title="Models"
        description="One API key reaches every model your account can call. Pass the model id shown on each card as the model field of your request."
        action={
          <Link
            href="/integrations"
            className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          >
            See request examples
          </Link>
        }
      />

      <StatGrid>
        <StatCard
          label="Available to you"
          value={formatNumber(catalogue.availableCount)}
          tone="brand"
          hint={`${catalogue.planName} account`}
        />
        <StatCard
          label="Locked"
          value={formatNumber(locked)}
          tone={locked > 0 ? "amber" : "default"}
          hint={
            locked > 0 ? (
              // Named for the only thing that actually unlocks them. "Upgrade" implied a tier
              // ladder to climb, and there is none — one purchase opens the whole catalogue.
              <Link href="/subscription" className="text-brand transition-colors hover:underline">
                Unlock every model with Unlimited
              </Link>
            ) : (
              "Full catalogue unlocked"
            )
          }
        />
        <StatCard label="Categories" value={formatNumber(catalogue.categories.length)} />
        <StatCard label="Providers" value={formatNumber(catalogue.providers.length)} />
        <StatCard
          label="Catalogue size"
          value={formatNumber(catalogue.models.length)}
          hint="Enabled models"
        />
      </StatGrid>

      <ModelBrowser catalogue={catalogue} />
    </>
  );
}
