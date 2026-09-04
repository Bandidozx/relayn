/**
 * Public landing page.
 *
 * This is the only route that renders without a session, so it deliberately shows nothing
 * account-specific: catalogue counts and plan definitions only, both read from the same
 * database and constants the dashboard uses. The header adapts to an existing session so a
 * signed-in visitor lands on a link to their dashboard rather than a second sign-in prompt.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/layout/brand";
import { Badge } from "@/components/ui/badge";
import { CodeTabs, type CodeTab } from "@/components/ui/code-block";
import { getSession } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { env } from "@/lib/env";
import { formatCompact, formatIdr, formatNumber, titleCase } from "@/lib/format";
import { PLANS, PLAN_ORDER, UNLIMITED_PRICE_IDR } from "@/lib/plans";
import { PLACEHOLDER_KEY, quickstartSnippets, type SnippetContext } from "@/lib/snippets";
import { publicCatalogueSummary } from "@/server/services/models-service";

export const metadata: Metadata = {
  title: "Relayn — one API key for every model",
  /**
   * Only the landing page declares a canonical. Relative `metadata` URLs are composed with
   * `metadataBase`'s origin rather than the current path, so a canonical set in the root
   * layout would claim the site root on every dashboard route; this is the one route where
   * "/" is the truth. The dashboard is `noindex` anyway.
   */
  alternates: { canonical: "/" },
};

const STEPS: Array<[string, string]> = [
  ["Key check", "The bearer token is SHA-256 hashed and compared in constant time. Revoked keys stop working immediately."],
  ["Account & plan", "Suspended accounts and inactive subscriptions are refused before any upstream call is made."],
  ["Allocation", "Remaining tokens are checked against the plan allocation, so an exhausted budget fails fast with 402."],
  ["Model authorisation", "The requested model must exist, be enabled, and be permitted on the caller's plan."],
  ["Routing", "The model's provider adapter is selected at runtime. Upstream credentials stay server-side."],
  ["Accounting", "Prompt and completion tokens, latency, cost and status are written to the usage log per request."],
];

export default async function LandingPage() {
  const [session, catalogue] = await Promise.all([getSession(), publicCatalogueSummary()]);

  const context: SnippetContext = {
    baseUrl: env.appUrl,
    apiKey: PLACEHOLDER_KEY,
    model: catalogue.sampleModelId ?? "relayn/no-model-seeded",
  };
  const tabs: CodeTab[] = quickstartSnippets(context);

  return (
    <div className="grid-backdrop min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <Brand href="/" showTagline />
        <nav className="flex items-center gap-2 text-xs">
          <a href="#how" className="hidden px-2 text-ink-muted transition-colors hover:text-ink sm:inline">
            How it works
          </a>
          <a href="#api" className="hidden px-2 text-ink-muted transition-colors hover:text-ink sm:inline">
            API
          </a>
          <a href="#plans" className="hidden px-2 text-ink-muted transition-colors hover:text-ink sm:inline">
            Plans
          </a>
          {session ? (
            <Link
              href="/dashboard"
              className="rounded-lg bg-brand px-3 py-1.5 font-medium text-black transition-opacity hover:opacity-90"
            >
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="rounded-lg border border-line-strong px-3 py-1.5 text-ink-muted transition-colors hover:bg-hover hover:text-ink">
                Sign in
              </Link>
              <Link
                href="/register"
                className="rounded-lg bg-brand px-3 py-1.5 font-medium text-black transition-opacity hover:opacity-90"
              >
                Create account
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-16 px-5 pb-20 sm:px-8">
        <section className="pt-8 sm:pt-14">
          <Badge tone="brand" dot>
            OpenAI-compatible gateway
          </Badge>
          <h1 className="mt-4 max-w-3xl text-3xl leading-tight font-semibold tracking-tight text-ink sm:text-5xl">
            One API key for every frontier model.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
            Point any OpenAI client at Relayn and call models from several providers through a
            single key. Every request is metered: tokens, latency, cost and status land in a usage
            log you can search — so you can see where the budget went instead of guessing.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              href={session ? "/dashboard" : "/register"}
              className="rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
            >
              {session ? "Open dashboard" : "Create a free account"}
            </Link>
            <a
              href="#api"
              className="rounded-xl border border-line-strong px-4 py-2.5 text-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            >
              See a request
            </a>
          </div>

          <dl className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ["Models enabled", formatNumber(catalogue.total)],
                ["Providers wired", formatNumber(catalogue.providers.length)],
                ["Largest context", catalogue.maxContextWindow === 0 ? "—" : `${formatCompact(catalogue.maxContextWindow)} tokens`],
                ["Free tier", `${formatCompact(PLANS.free.tokenAllocation)} tokens / month`],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="panel px-4 py-3.5">
                <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
                <dd className="numeric mt-1 text-lg text-ink">{value}</dd>
              </div>
            ))}
          </dl>
          {catalogue.total === 0 ? (
            <p className="mt-3 rounded-xl border border-amber/30 bg-amber/8 px-3.5 py-3 text-[11px] leading-relaxed text-ink-muted">
              The catalogue is empty in this deployment — run{" "}
              <span className="numeric text-ink">npm run db:seed</span> to load the starter model
              list. These counts read the database, so they stay at zero until it has rows.
            </p>
          ) : null}
        </section>
        <section id="how" className="scroll-mt-24">
          <h2 className="text-xl font-semibold tracking-tight text-ink">
            What happens on every request
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
            The gateway runs the same ordered checks for every call. Nothing reaches an upstream
            provider until the key, the account, the budget and the model have all cleared.
          </p>
          <ol className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map(([title, body], index) => (
              <li key={title} className="panel p-4">
                <span className="numeric text-[11px] text-brand">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-1 text-sm font-medium text-ink">{title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{body}</p>
              </li>
            ))}
          </ol>
          {catalogue.categories.length > 0 ? (
            <ul className="mt-5 flex flex-wrap gap-2">
              {catalogue.categories.map((entry) => (
                <li
                  key={entry.category}
                  className="rounded-lg border border-line bg-raised/60 px-2.5 py-1 text-[11px] text-ink-muted"
                >
                  {titleCase(entry.category)}
                  <span className="numeric ml-1.5 text-ink-faint">{entry.count}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section id="api" className="scroll-mt-24">
          <h2 className="text-xl font-semibold tracking-tight text-ink">Drop-in compatible</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
            Change the base URL and the key. The request and response bodies match the OpenAI Chat
            Completions shape, streaming included, and there is an Anthropic-dialect endpoint at{" "}
            <span className="numeric text-ink">POST /v1/messages</span> for clients that prefer it.
          </p>
          <div className="panel mt-6 p-4">
            <CodeTabs tabs={tabs} />
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
            Base URL for this deployment:{" "}
            <span className="numeric text-ink-muted">{env.appUrl}/v1</span>. Create an account to
            mint a key and read the full reference — error codes, rate limits and response headers
            are documented per endpoint.
          </p>
        </section>
        <section id="plans" className="scroll-mt-24">
          <h2 className="text-xl font-semibold tracking-tight text-ink">Plans</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">
            Allocations and rate limits are enforced by the gateway, not just displayed here. The
            monthly tiers are not billed — switching between them applies immediately and no card is
            ever charged. <span className="text-ink">Unlimited</span> is the one thing that costs
            money: a single {formatIdr(UNLIMITED_PRICE_IDR)} QRIS payment that never renews.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {PLAN_ORDER.map((id) => {
              const plan = PLANS[id];
              return (
                <article
                  key={id}
                  className={cn(
                    "panel flex flex-col p-4",
                    plan.oneTime && "border-brand/45 ring-1 ring-brand/20",
                  )}
                >
                  <header>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-ink">{plan.name}</h3>
                      {plan.oneTime ? (
                        <span className="rounded-full border border-brand/30 bg-brand/12 px-1.5 py-0.5 text-[10px] text-brand">
                          one-time
                        </span>
                      ) : null}
                    </div>
                    <p className="numeric mt-1 text-lg text-ink">
                      {plan.priceLabel ?? (plan.priceMonthlyUsd === 0 ? "Free" : `$${plan.priceMonthlyUsd}`)}
                      {plan.priceLabel || plan.priceMonthlyUsd === 0 ? null : (
                        <span className="text-[11px] text-ink-faint"> /month</span>
                      )}
                    </p>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                      {plan.tagline}
                    </p>
                  </header>
                  <ul className="mt-3 space-y-1.5 text-[11px] text-ink-muted">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex gap-1.5">
                        <span className="text-brand">·</span>
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <p className="numeric mt-3 border-t border-line pt-2.5 text-[11px] text-ink-faint">
                    {formatNumber(plan.requestsPerMinute)} req/min ·{" "}
                    {plan.maxApiKeys === null ? "unlimited keys" : `${plan.maxApiKeys} keys`}
                  </p>
                  <Link
                    href={session ? "/subscription" : "/register"}
                    className="mt-auto pt-3 text-[11px] text-brand transition-opacity hover:opacity-80"
                  >
                    {plan.oneTime
                      ? `Buy for ${formatIdr(plan.priceIdr ?? UNLIMITED_PRICE_IDR)} →`
                      : plan.selfServe
                        ? "Choose this plan →"
                        : "Talk to us →"}
                  </Link>
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-[11px] text-ink-faint sm:px-8">
          <p>
            Relayn — self-hosted AI gateway. Provider credentials stay in your environment and are
            never sent to the browser.
          </p>
          <nav className="flex gap-3">
            <Link href="/login" className="transition-colors hover:text-ink">
              Sign in
            </Link>
            <Link href="/register" className="transition-colors hover:text-ink">
              Create account
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
