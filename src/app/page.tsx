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
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { getSession } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { env } from "@/lib/env";
import { formatCompact, formatIdr, formatNumber, titleCase } from "@/lib/format";
import { cryptoPaymentsConfigured } from "@/lib/payments/crypto/registry";
import { paymentsConfigured } from "@/lib/payments/registry";
import {
  PLANS,
  PUBLIC_PLAN_ORDER,
  UNLIMITED_PRICE_IDR,
  UNLIMITED_PRICE_USD_LABEL,
} from "@/lib/plans";
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

  /*
   * Which rail this deployment actually charges on, derived exactly as `getSubscription` derives
   * `purchaseRail` — crypto wins when it is configured, and is also the fallback when neither rail
   * is set up so the price quoted here can never contradict the checkout card on /subscription.
   */
  const onChain = cryptoPaymentsConfigured() || !paymentsConfigured();
  const purchaseLabel = onChain ? UNLIMITED_PRICE_USD_LABEL : formatIdr(UNLIMITED_PRICE_IDR);

  const context: SnippetContext = {
    baseUrl: env.appUrl,
    apiKey: PLACEHOLDER_KEY,
    model: catalogue.sampleModelId ?? "relayn/no-model-seeded",
  };
  const tabs: CodeTab[] = quickstartSnippets(context);

  return (
    <div className="relative min-h-dvh overflow-x-hidden">
      {/* Background grid + Aurora glow */}
      <div className="grid-backdrop absolute inset-0 -z-20" aria-hidden />
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 flex justify-center overflow-hidden" aria-hidden>
        {/*
         * The aurora is the same three accent hues in both themes — but those hues darken for the
         * light palette, and a dark blur at this alpha over white paper reads as a stain rather
         * than a bloom. Dimming it is the only thing light mode needs here.
         */}
        <div className="h-[500px] w-[850px] -translate-y-1/3 rounded-full bg-gradient-to-tr from-brand/20 via-sky/15 to-violet/20 blur-[130px] opacity-75 light:opacity-40" />
      </div>

      <header className="sticky top-0 z-50 border-b border-line/40 bg-canvas/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
          <Brand href="/" showTagline />
          <nav className="flex items-center gap-2 text-xs">
            <a href="#how" className="hidden px-2.5 py-1 text-ink-muted transition-colors hover:text-ink sm:inline">
              How it works
            </a>
            <a href="#api" className="hidden px-2.5 py-1 text-ink-muted transition-colors hover:text-ink sm:inline">
              API
            </a>
            <a href="#plans" className="hidden px-2.5 py-1 text-ink-muted transition-colors hover:text-ink sm:inline">
              Pricing
            </a>
            {/*
             * On the landing page too, not only inside the dashboard: a visitor whose OS is set to
             * light gets a light site and needs a way to say "actually, dark" before signing up.
             */}
            <ThemeToggle className="mr-0.5" />
            {session ? (
              <Link
                href="/dashboard"
                className="rounded-xl bg-brand px-3.5 py-1.5 font-semibold text-brand-ink transition-all hover:bg-brand-strong hover:scale-105 active:scale-[0.98] shadow-sm shadow-brand/20"
              >
                Open dashboard
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="rounded-xl border border-line-strong px-3 py-1.5 font-medium text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  Sign in
                </Link>
                <Link
                  href="/register"
                  className="rounded-xl bg-brand px-3.5 py-1.5 font-semibold text-brand-ink transition-all hover:bg-brand-strong hover:scale-105 active:scale-[0.98] shadow-sm shadow-brand/20"
                >
                  Create account
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-20 px-5 pt-4 pb-24 sm:px-8 sm:space-y-24">
        <section className="pt-10 sm:pt-16">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand/35 bg-brand/10 px-3.5 py-1 text-xs font-medium text-brand backdrop-blur-md shadow-[0_0_20px_-3px_var(--glow-brand)]">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-brand" />
            </span>
            OpenAI & Anthropic Compatible Gateway
          </div>

          <h1 className="mt-5 max-w-3xl text-4xl leading-tight font-extrabold tracking-tight text-ink sm:text-6xl sm:leading-[1.1]">
            One API key for every{" "}
            {/*
             * Three palette accents rather than a Tailwind default in the middle: the old
             * `via-emerald-300` is a pale mint that sits at about 1.5:1 on the light canvas, so the
             * centre of the headline would have faded out. `sky` and `violet` darken with the
             * palette like `brand` does, so the gradient stays legible in both themes.
             */}
            <span className="bg-gradient-to-r from-brand via-sky to-violet bg-clip-text text-transparent">
              frontier model.
            </span>
          </h1>

          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
            Point any OpenAI or Anthropic client at Relayn and route calls across several frontier
            providers with a single unified key. Every request is recorded: tokens, latency, cost, and
            status land in a searchable log so you stay in total control of your budget.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3.5">
            <Link
              href={session ? "/dashboard" : "/register"}
              className="rounded-xl bg-brand px-5 py-3 text-sm font-semibold text-brand-ink shadow-[0_0_24px_-4px_var(--glow-brand),inset_0_1px_0_var(--sheen-strong)] transition-all duration-200 hover:bg-brand-strong hover:scale-105 active:scale-[0.98]"
            >
              {session ? "Open dashboard" : "Create a free account"}
            </Link>
            <a
              href="#api"
              className="rounded-xl border border-line-strong bg-surface/50 px-5 py-3 text-sm font-medium text-ink-muted backdrop-blur-sm transition-all hover:bg-hover hover:border-ink-faint hover:text-ink"
            >
              See a request
            </a>
          </div>

          <dl className="mt-12 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ["Models enabled", formatNumber(catalogue.total)],
                ["Providers wired", formatNumber(catalogue.providers.length)],
                ["Largest context", catalogue.maxContextWindow === 0 ? "—" : `${formatCompact(catalogue.maxContextWindow)} tokens`],
                ["Free tier", `${formatCompact(PLANS.free.tokenAllocation)} tokens / mo`],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="group rounded-2xl border border-line/70 bg-gradient-to-b from-surface/85 to-surface/40 p-4.5 backdrop-blur-md shadow-[inset_0_1px_0_var(--sheen)] transition-all duration-300 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-xl"
              >
                <dt className="text-[11px] font-semibold tracking-wider text-ink-faint uppercase">{label}</dt>
                <dd className="numeric mt-1.5 text-2xl font-bold text-ink group-hover:text-ink-strong transition-colors">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {catalogue.total === 0 ? (
            <p className="mt-4 rounded-2xl border border-amber/30 bg-amber/10 p-4 text-xs leading-relaxed text-ink-muted">
              The catalogue is empty in this deployment — run{" "}
              <span className="numeric font-semibold text-ink">npm run db:seed</span> to load the starter model
              list. These counts read the database, so they stay at zero until seeded.
            </p>
          ) : null}
        </section>

        <section id="how" className="scroll-mt-24">
          <div className="flex flex-col gap-2">
            <Badge tone="violet" className="w-fit">Architecture</Badge>
            <h2 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              What happens on every request
            </h2>
            <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
              The gateway executes ordered pipeline stages for every call. Nothing reaches an upstream
              provider until authentication, tier clearance, token budget, and model rights are validated.
            </p>
          </div>

          <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {STEPS.map(([title, body], index) => (
              <li
                key={title}
                className="group rounded-2xl border border-line/70 bg-gradient-to-b from-surface/85 to-surface/45 p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:border-brand/40 hover:shadow-xl hover:shadow-brand/5"
              >
                <span className="font-mono text-xs font-bold text-brand">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-2 text-sm font-semibold text-ink group-hover:text-ink-strong transition-colors">
                  {title}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">{body}</p>
              </li>
            ))}
          </ol>

          {catalogue.categories.length > 0 ? (
            <ul className="mt-6 flex flex-wrap gap-2">
              {catalogue.categories.map((entry) => (
                <li
                  key={entry.category}
                  className="rounded-full border border-line/70 bg-raised/50 px-3 py-1 text-xs font-medium text-ink-muted"
                >
                  {titleCase(entry.category)}
                  <span className="numeric ml-1.5 font-mono text-ink-faint">{entry.count}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section id="api" className="scroll-mt-24">
          <div className="flex flex-col gap-2">
            <Badge tone="sky" className="w-fit">Developer Experience</Badge>
            <h2 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Drop-in compatible</h2>
            <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
              Simply update your base URL and bearer token. The request and response bodies match the OpenAI Chat
              Completions specification, including full streaming support.
            </p>
          </div>

          {/* `shadow-pop`, not Tailwind's `shadow-2xl`: the latter is a fixed black smear that
              would also overwrite the tokenised shadow `panel-glass` already carries. */}
          <div className="panel-glass mt-8 p-4 sm:p-6 shadow-pop">
            <CodeTabs tabs={tabs} />
          </div>

          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Base URL for this deployment:{" "}
            <span className="numeric font-mono text-ink-muted">{env.appUrl}/v1</span>. Create an account to
            mint a key and explore live latency and rate limit headers.
          </p>
        </section>

        <section id="plans" className="scroll-mt-24">
          <div className="flex flex-col gap-2">
            <Badge tone="brand" className="w-fit">Transparent Pricing</Badge>
            <h2 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Two states, one price.</h2>
            <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
              Every new account starts on <span className="font-semibold text-ink">Free</span> with a monthly token allocation the gateway
              actually enforces. <span className="font-semibold text-ink">Unlimited</span> is the only thing that
              costs money: {purchaseLabel}, paid once, no renewal and no token ceiling afterwards.
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:max-w-3xl">
            {PUBLIC_PLAN_ORDER.map((id) => {
              const plan = PLANS[id];
              return (
                <article
                  key={id}
                  className={cn(
                    "relative flex flex-col justify-between rounded-2xl border p-6 backdrop-blur-md transition-all duration-300 hover:-translate-y-1",
                    plan.oneTime
                      ? "border-brand/50 bg-gradient-to-b from-brand/10 via-surface/90 to-surface/60 shadow-[0_0_30px_-5px_var(--glow-brand)] ring-1 ring-brand/30"
                      : "border-line/70 bg-gradient-to-b from-surface/85 to-surface/45 hover:border-line-strong hover:shadow-xl",
                  )}
                >
                  <header>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-base font-semibold text-ink">{plan.name}</h3>
                      {plan.oneTime ? (
                        <span className="rounded-full border border-brand/40 bg-brand/15 px-2.5 py-0.5 text-[10px] font-semibold text-brand shadow-sm shadow-brand/20">
                          one-time
                        </span>
                      ) : null}
                    </div>
                    <p className="numeric mt-2 text-2xl font-bold text-ink">
                      {plan.oneTime ? purchaseLabel : "Free"}
                      {plan.oneTime ? (
                        <span className="text-xs font-normal text-ink-faint"> once</span>
                      ) : null}
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
                      {plan.tagline}
                    </p>
                  </header>

                  <ul className="my-5 space-y-2 text-xs text-ink-muted">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-center gap-2">
                        <span className="size-1.5 rounded-full bg-brand" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-auto border-t border-line/60 pt-3.5">
                    <p className="numeric font-mono text-[11px] text-ink-faint">
                      {formatNumber(plan.requestsPerMinute)} req/min ·{" "}
                      {plan.maxApiKeys === null ? "unlimited keys" : `${plan.maxApiKeys} keys`}
                    </p>
                    <Link
                      href={session ? "/subscription" : "/register"}
                      className="mt-3 inline-block font-semibold text-xs text-brand transition-opacity hover:opacity-80"
                    >
                      {plan.oneTime
                        ? `Buy for ${purchaseLabel} →`
                        : session
                          ? "Open your dashboard →"
                          : "Create a free account →"}
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>

          <p className="mt-5 max-w-2xl text-[11px] leading-relaxed text-ink-faint">
            {onChain
              ? `Payment is an on-chain USDC transfer. The amount, recipient and sender are read back from the blockchain by our server before anything is activated — a transaction hash is the only thing the browser sends, and each one can activate exactly one account.`
              : `Payment is verified server-side from the provider's signed callback before anything is activated. The browser never decides whether an account is paid.`}{" "}
            Higher fixed allocations, private routing pools and SLAs are arranged directly — there is
            no self-serve tier ladder and no card is ever stored.
          </p>
        </section>
      </main>

      <footer className="border-t border-line/60 bg-surface/30 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-xs text-ink-faint sm:px-8">
          <p>
            Relayn — self-hosted AI gateway. Provider credentials stay safe in your environment and are
            never exposed.
          </p>
          <nav className="flex gap-4">
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
