import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { StatCard, StatGrid } from "@/components/dashboard/stat-card";
import {
  TopModelsCard,
  TrendWindowProvider,
  TrendWindowSwitcher,
  WindowStatCards,
  WindowTrendChart,
} from "@/components/dashboard/trend-window";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Td, TableWrap, Th, Tr } from "@/components/ui/table";
import { getSession } from "@/lib/auth/session";
import { planOf } from "@/lib/plans";
import { getDashboardOverview } from "@/lib/usage/metrics";
import {
  formatCompact,
  formatDate,
  formatLatency,
  formatMicroUsd,
  formatNumber,
  formatPercent,
  formatRelative,
} from "@/lib/format";

export const metadata: Metadata = { title: "Overview" };

/**
 * The 7/14/30 range switcher is client-side: `getDashboardOverview` folds all three windows
 * out of one `usage_logs` scan, so there is no `?days=` search param and no navigation —
 * which also removes the three speculative prefetch renders the old `<Link>`s triggered.
 */
export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const overview = await getDashboardOverview(session.user.id);
  const { cards, quota, runway, recent } = overview;
  const plan = planOf(quota.plan);

  return (
    <TrendWindowProvider windows={overview.windows} defaultWindow={overview.defaultWindow}>
      <PageHeader
        title={`Welcome back, ${session.user.name.split(" ")[0] ?? session.user.name}`}
        description="Live traffic, token consumption and budget health for your gateway account. Every figure below is computed from your recorded requests."
        action={<TrendWindowSwitcher />}
      />

      <StatGrid>
        {quota.unlimited ? (
          // A paid unlimited account has no remaining count to show — "2.0B left" would be a
          // sentinel leaking into the UI as if it were a real budget.
          <StatCard
            label="Token access"
            value="Unlimited"
            tone="brand"
            hint={`${plan.name} · permanent, no renewal · ${formatCompact(quota.used)} used all-time`}
          />
        ) : (
          <StatCard
            label="Tokens remaining"
            value={formatCompact(cards.tokensRemaining)}
            tone={quota.exhausted ? "rose" : quota.percentUsed >= 80 ? "amber" : "brand"}
            hint={`of ${formatCompact(quota.allocation)} on ${plan.name} · resets ${formatDate(quota.renewalDate)}`}
          />
        )}
        <StatCard
          label="Tokens used today"
          value={formatCompact(cards.tokensUsedToday)}
          hint={
            quota.unlimited
              ? `${formatCompact(cards.tokensUsedThisMonth)} this month`
              : `${formatCompact(cards.tokensUsedThisMonth)} this billing cycle`
          }
        />
        <StatCard
          label="Requests today"
          value={formatNumber(cards.requestsToday)}
          hint={`${formatNumber(cards.requestsThisMonth)} this ${quota.unlimited ? "month" : "cycle"} · limit ${plan.requestsPerMinute}/min`}
        />
        <WindowStatCards />
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader
            title="Usage trend"
            description="Daily totals across every API key on your account."
            action={
              <Badge tone="neutral">{formatMicroUsd(cards.spendMicroUsdThisMonth)} this cycle</Badge>
            }
          />
          <CardBody>
            <WindowTrendChart />
          </CardBody>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader
              title={quota.unlimited ? "Consumption rate" : "Budget runway"}
              description="Projected from your last seven active days."
            />
            <CardBody className="space-y-3">
              {runway.avgDailyTokens === 0 ? (
                <EmptyState
                  compact
                  title="Not enough history yet"
                  description={
                    quota.unlimited
                      ? "Once you have a day of traffic we will show your average daily consumption."
                      : "Once you have a day of traffic we will project when your allocation runs out."
                  }
                />
              ) : quota.unlimited ? (
                // Nothing to project: there is no allocation to exhaust. The average rate is
                // still worth showing — it is the only budget-shaped number that stays true.
                <>
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="numeric text-2xl leading-none font-semibold text-ink">
                        {formatCompact(runway.avgDailyTokens)}
                      </p>
                      <p className="mt-1 text-[11px] text-ink-faint">tokens / active day</p>
                    </div>
                    <Badge tone="brand" dot>
                      No ceiling
                    </Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-ink-muted">
                    Your access is permanent and uncapped, so there is nothing to run out of.
                    This is your recent consumption rate for reference only.
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="numeric text-2xl leading-none font-semibold text-ink">
                        {runway.daysRemaining === null ? "—" : `${runway.daysRemaining}d`}
                      </p>
                      <p className="mt-1 text-[11px] text-ink-faint">
                        at {formatCompact(runway.avgDailyTokens)} tokens / active day
                      </p>
                    </div>
                    <Badge tone={runway.onTrack ? "brand" : "rose"} dot>
                      {runway.onTrack ? "On track" : "Will exhaust early"}
                    </Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-ink-muted">
                    {runway.projectedExhaustion === null
                      ? "Your allocation is not being consumed at a measurable rate."
                      : runway.onTrack
                        ? `At the current rate your allocation lasts past the ${formatDate(quota.renewalDate)} reset.`
                        : `At the current rate you run out around ${formatDate(runway.projectedExhaustion)} — before the ${formatDate(quota.renewalDate)} reset.`}
                  </p>
                </>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={quota.unlimited ? "Your access" : "Current allocation"}
              description={`${plan.name} plan`}
              action={
                <Link
                  href="/subscription"
                  className="rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  {quota.unlimited ? "View access" : "Change plan"}
                </Link>
              }
            />
            <CardBody className="space-y-3">
              {quota.unlimited ? (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-lg font-semibold text-brand">Unlimited</p>
                    <span className="numeric text-xs text-ink-muted">
                      {formatCompact(quota.used)} used
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed text-ink-muted">
                    One-time payment, permanent access. Every model in the catalogue is
                    available and there is no monthly allocation to reset.
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="numeric text-lg font-semibold text-ink">
                      {formatCompact(quota.used)}
                      <span className="text-sm font-normal text-ink-faint">
                        {" "}
                        / {formatCompact(quota.allocation)} tokens
                      </span>
                    </p>
                    <span className="numeric text-xs text-ink-muted">
                      {formatPercent(quota.percentUsed, 1)}
                    </span>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full bg-line"
                    role="progressbar"
                    aria-valuenow={Math.round(quota.percentUsed)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Allocation used"
                  >
                    <div
                      className={
                        quota.percentUsed >= 90
                          ? "h-full rounded-full bg-rose"
                          : quota.percentUsed >= 70
                            ? "h-full rounded-full bg-amber"
                            : "h-full rounded-full bg-brand"
                      }
                      style={{ width: `${Math.min(100, quota.percentUsed)}%` }}
                    />
                  </div>
                </>
              )}
              <dl className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-lg border border-line bg-raised/50 px-2.5 py-2">
                  <dt className="text-ink-faint">Active keys</dt>
                  <dd className="numeric mt-0.5 text-ink">
                    {overview.activeKeys}
                    <span className="text-ink-faint"> / {overview.totalKeys} total</span>
                  </dd>
                </div>
                <div className="rounded-lg border border-line bg-raised/50 px-2.5 py-2">
                  <dt className="text-ink-faint">Subscription</dt>
                  <dd className="mt-0.5">
                    <StatusBadge status={quota.status} />
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader
            title="Recent activity"
            description="The last eight requests your keys made."
            action={
              <Link
                href="/usage"
                className="text-[11px] text-brand transition-opacity hover:opacity-80"
              >
                View all logs →
              </Link>
            }
          />
          {recent.length === 0 ? (
            <EmptyState
              title="No requests recorded yet"
              description="Create an API key and send your first request — this table fills in automatically from the gateway."
              action={
                <Link
                  href="/api-keys"
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-brand-ink transition-opacity hover:opacity-90"
                >
                  Create an API key
                </Link>
              }
            />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Model</Th>
                  <Th>Key</Th>
                  <Th align="right">Tokens</Th>
                  <Th align="right">Latency</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <Tr key={row.id}>
                    <Td className="whitespace-nowrap text-ink">{formatRelative(row.createdAt)}</Td>
                    <Td className="numeric text-ink">{row.modelId}</Td>
                    <Td>{row.apiKeyName ?? "—"}</Td>
                    <Td align="right" className="numeric text-ink">
                      {formatNumber(row.totalTokens)}
                    </Td>
                    <Td align="right" className="numeric">
                      {formatLatency(row.latencyMs)}
                    </Td>
                    <Td>
                      {row.status === "success" ? (
                        <StatusBadge status="success" />
                      ) : (
                        <Badge tone="rose" dot>
                          {row.errorCode ?? "error"}
                        </Badge>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <TopModelsCard />
      </div>
    </TrendWindowProvider>
  );
}
