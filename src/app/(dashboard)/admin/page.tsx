import type { Metadata } from "next";
import Link from "next/link";
import { StatCard, StatGrid } from "@/components/dashboard/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCompact, formatMicroUsd, formatNumber, formatPercent } from "@/lib/format";
import { getAdminStats, listAdminProviders } from "@/server/services/admin-service";

export const metadata: Metadata = { title: "Admin · Overview" };

export default async function AdminOverviewPage() {
  const [stats, providers] = await Promise.all([getAdminStats(), listAdminProviders()]);

  const errorRate =
    stats.requests.last24h === 0 ? null : (stats.requests.errors24h / stats.requests.last24h) * 100;
  const configured = providers.filter((provider) => provider.configured);
  const totalPlanned = stats.plans.reduce((sum, row) => sum + row.count, 0);

  return (
    <>
      <StatGrid>
        <StatCard
          label="Users"
          value={formatNumber(stats.users.total)}
          tone="brand"
          hint={`${formatNumber(stats.users.active)} active · ${formatNumber(stats.users.suspended)} suspended`}
        />
        <StatCard
          label="New this week"
          value={formatNumber(stats.users.newThisWeek)}
          hint={`${formatNumber(stats.users.admins)} ${stats.users.admins === 1 ? "administrator" : "administrators"}`}
        />
        <StatCard
          label="Requests (24h)"
          value={formatNumber(stats.requests.last24h)}
          hint={`${formatNumber(stats.requests.total)} all time`}
        />
        <StatCard
          label="Error rate (24h)"
          value={errorRate === null ? "—" : formatPercent(errorRate, 1)}
          tone={errorRate === null ? "default" : errorRate >= 5 ? "rose" : errorRate >= 1 ? "amber" : "default"}
          hint={
            stats.requests.last24h === 0
              ? "No traffic in the last 24 hours"
              : `${formatNumber(stats.requests.errors24h)} failed of ${formatNumber(stats.requests.last24h)}`
          }
        />
        <StatCard
          label="Tokens (24h)"
          value={formatCompact(stats.tokens.last24h)}
          hint={`${formatCompact(stats.tokens.last30d)} over 30 days`}
        />
        <StatCard
          label="Metered spend (30d)"
          value={formatMicroUsd(stats.spendMicroUsd.last30d)}
          hint="Catalogue price of all traffic — nothing is charged"
        />
        <StatCard
          label="Active keys"
          value={formatNumber(stats.keys.active)}
          hint={`${formatNumber(stats.keys.revoked)} revoked`}
        />
        <StatCard
          label="Open tickets"
          value={formatNumber(stats.tickets.open)}
          tone={stats.tickets.open > 0 ? "amber" : "default"}
          hint={`${formatNumber(stats.tickets.total)} total`}
        />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader
            title="Plan distribution"
            description="Subscriptions by tier, from the subscription table."
          />
          <CardBody>
            {totalPlanned === 0 ? (
              <EmptyState compact title="No subscriptions yet" description="Every account gets one on first sign-in." />
            ) : (
              <ul className="space-y-2.5">
                {stats.plans.map((row) => {
                  const share = (row.count / totalPlanned) * 100;
                  return (
                    <li key={row.plan}>
                      <div className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-ink">{row.planName}</span>
                        <span className="numeric text-ink-faint">
                          {formatNumber(row.count)} · {formatPercent(share, 0)}
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${share}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Providers"
            description={`${configured.length} of ${providers.length} have a credential set.`}
            action={
              <Link
                href="/admin/providers"
                className="text-[11px] text-brand transition-opacity hover:opacity-80"
              >
                Details
              </Link>
            }
          />
          <CardBody className="space-y-2">
            {providers.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs text-ink">{provider.label}</p>
                  <p className="numeric truncate text-[11px] text-ink-faint">
                    {formatNumber(provider.models)} {provider.models === 1 ? "model" : "models"}
                  </p>
                </div>
                <Badge tone={provider.configured ? "brand" : "neutral"} dot>
                  {provider.configured ? "Configured" : "No credential"}
                </Badge>
              </div>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Catalogue & queue" description="What is callable and what needs a reply." />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {(
                [
                  ["Models enabled", `${formatNumber(stats.models.enabled)} / ${formatNumber(stats.models.total)}`],
                  ["Providers configured", `${configured.length} / ${providers.length}`],
                  ["Open tickets", formatNumber(stats.tickets.open)],
                  ["Tickets all time", formatNumber(stats.tickets.total)],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
                  <dd className="numeric mt-0.5 text-sm text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            {configured.length === 0 ? (
              <p className="mt-4 rounded-xl border border-amber/30 bg-amber/8 px-3.5 py-3 text-[11px] leading-relaxed text-ink-muted">
                No upstream credential is set, so live completions will fail with{" "}
                <span className="numeric text-ink">503 provider_unconfigured</span>. Set one of the
                env vars listed on the Providers tab and restart.
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
