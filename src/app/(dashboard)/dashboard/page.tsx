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
import { cn } from "@/lib/cn";
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

  const overview = await getDashboardOverview(session.user);
  const { cards, quota, runway, recent } = overview;
  const plan = planOf(quota.plan);
  /*
   * Uncapped by role, with no purchase behind it. Every "one-time payment", "permanent" and "no
   * renewal" string below is a receipt, and an operator who never paid must not be shown one — the
   * exemption is real but it ends with the role, so the copy has to say that instead.
   */
  const byRoleOnly = quota.unlimitedByRole && !quota.unlimitedByPayment;

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
            hint={
              byRoleOnly
                ? `Admin role · not metered · ${formatCompact(quota.used)} used all-time`
                : `${plan.name} · permanent, no renewal · ${formatCompact(quota.used)} used all-time`
            }
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

      {/*
       * `grid-cols-1` at the base and `minmax(0, …)` at `xl` are both load-bearing, not tidying.
       *
       * A grid track sized `auto` — which is what a single implicit column is — or a bare `1fr`
       * takes its minimum from its content, and the recent-activity card below contains a
       * `min-w-max` table. So the track grew to the table's full width, the card grew with it,
       * and the whole page scrolled sideways on a phone instead of the table scrolling inside its
       * own `overflow-x-auto` wrapper. `grid-cols-1` compiles to `repeat(1, minmax(0, 1fr))`,
       * which is exactly the clamp that hands the overflow back to the wrapper.
       *
       * Nothing moves when the content already fits, so this is invisible on a wide screen.
       */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
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
                    {byRoleOnly
                      ? "Your admin role exempts this account from the token ceiling, so there is nothing to run out of. This is your recent consumption rate for reference only."
                      : "Your access is permanent and uncapped, so there is nothing to run out of. This is your recent consumption rate for reference only."}
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
              description={`${plan.name} account`}
              action={
                <Link
                  href="/subscription"
                  className="rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  {/* "Change plan" pointed at a picker that no longer exists — the one move a
                      metered account has is the one-time purchase. */}
                  {quota.unlimited ? "View access" : "Go unlimited"}
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
                    {byRoleOnly
                      ? "Administrators are not metered. Every model in the catalogue is available and there is no allocation to reset — for as long as the account holds the role."
                      : "One-time payment, permanent access. Every model in the catalogue is available and there is no monthly allocation to reset."}
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
                    className="h-2 overflow-hidden rounded-full bg-line/80"
                    role="progressbar"
                    aria-valuenow={Math.round(quota.percentUsed)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Allocation used"
                  >
                    <div
                      className={cn(
                        /*
                         * Both stops are palette tokens, so the bar darkens with the light theme
                         * instead of ending in a Tailwind default (`rose-400`, `emerald-400`) that
                         * washes out on paper. The leading edge stays the brighter of the two.
                         */
                        "h-full rounded-full bg-gradient-to-r transition-all duration-500",
                        quota.percentUsed >= 90
                          ? "from-rose/85 to-rose shadow-[0_0_10px_var(--glow-rose)]"
                          : quota.percentUsed >= 70
                            ? "from-amber/85 to-amber shadow-[0_0_10px_var(--glow-amber)]"
                            : "from-brand-strong to-brand shadow-[0_0_10px_var(--glow-brand)]",
                      )}
                      style={{ width: `${Math.min(100, quota.percentUsed)}%` }}
                    />
                  </div>
                </>
              )}
              <dl className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-xl border border-line/60 bg-raised/40 p-2.5">
                  <dt className="text-ink-faint">Active keys</dt>
                  <dd className="numeric mt-1 text-sm font-semibold text-ink">
                    {overview.activeKeys}
                    <span className="text-xs font-normal text-ink-faint"> / {overview.totalKeys} total</span>
                  </dd>
                </div>
                <div className="rounded-xl border border-line/60 bg-raised/40 p-2.5">
                  <dt className="text-ink-faint">Subscription</dt>
                  <dd className="mt-1">
                    <StatusBadge status={quota.status} />
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Same clamp as the grid above, and this is the one that held the `min-w-max` table. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Recent activity"
            description="The last eight requests processed by your gateway."
            action={
              <Link
                href="/usage"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand transition-opacity hover:opacity-80"
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
                  className="rounded-xl bg-brand px-3.5 py-2 text-xs font-semibold text-brand-ink transition-opacity hover:opacity-90 shadow-sm shadow-brand/20"
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
                    <Td className="whitespace-nowrap text-xs text-ink-muted">{formatRelative(row.createdAt)}</Td>
                    <Td className="numeric font-mono text-xs font-medium text-ink">{row.modelId}</Td>
                    <Td className="text-xs text-ink-muted">{row.apiKeyName ?? "—"}</Td>
                    <Td align="right" className="numeric font-mono text-xs text-ink">
                      {formatNumber(row.totalTokens)}
                    </Td>
                    <Td align="right" className="numeric font-mono text-xs text-ink-muted">
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
