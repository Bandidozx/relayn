"use client";

/**
 * Model catalogue browser.
 *
 * Locked models are shown greyed out rather than hidden: users can see what the one-time
 * Unlimited purchase opens up. That is a presentation choice only — the gateway re-checks
 * authorisation on every request, so a locked card is never a usable capability.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { formatLimit, formatPricePerMillion, titleCase } from "@/lib/format";
import { resolveVendor } from "@/lib/vendor";
import type { ModelCatalogue } from "@/server/services/models-service";
import { VendorMark } from "./vendor-mark";

const CATEGORY_TONES: Record<string, "brand" | "violet" | "sky" | "amber" | "neutral"> = {
  chat: "brand",
  reasoning: "violet",
  coding: "sky",
  vision: "amber",
  embeddings: "neutral",
};

export function ModelBrowser({ catalogue }: { catalogue: ModelCatalogue }) {
  const [category, setCategory] = useState("all");
  const [provider, setProvider] = useState("");
  const [search, setSearch] = useState("");
  const [availableOnly, setAvailableOnly] = useState(false);

  const models = useMemo(() => {
    const term = search.trim().toLowerCase();
    return catalogue.models.filter((model) => {
      if (category !== "all" && model.category !== category) return false;
      if (provider && model.provider !== provider) return false;
      if (availableOnly && !model.available) return false;
      if (!term) return true;
      return (
        model.name.toLowerCase().includes(term) ||
        model.modelId.toLowerCase().includes(term) ||
        model.description.toLowerCase().includes(term) ||
        model.capabilities.some((capability) => capability.toLowerCase().includes(term))
      );
    });
  }, [catalogue.models, category, provider, search, availableOnly]);

  const tabs = ["all", ...catalogue.categories];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Model category" className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line/60 bg-surface/50 p-1 backdrop-blur-md">
          {tabs.map((tab) => {
            const count =
              tab === "all"
                ? catalogue.models.length
                : catalogue.models.filter((model) => model.category === tab).length;
            return (
              <button
                key={tab}
                role="tab"
                type="button"
                aria-selected={tab === category}
                onClick={() => setCategory(tab)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
                  tab === category
                    ? "bg-brand/15 text-brand shadow-sm"
                    : "text-ink-muted hover:bg-hover hover:text-ink",
                )}
              >
                <span>{tab === "all" ? "All models" : titleCase(tab)}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.2 text-[10px] font-mono",
                    tab === category ? "bg-brand/20 text-brand" : "bg-raised text-ink-faint",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="model-search" className="sr-only">
            Search models
          </label>
          <Input
            id="model-search"
            value={search}
            placeholder="Search models…"
            className="h-8 w-52 text-xs"
            onChange={(event) => setSearch(event.target.value)}
          />
          <label htmlFor="model-provider" className="sr-only">
            Provider
          </label>
          <Select
            id="model-provider"
            value={provider}
            className="h-8 w-auto text-xs"
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="">All providers</option>
            {catalogue.providers.map((entry) => (
              <option key={entry} value={entry}>
                {titleCase(entry)}
              </option>
            ))}
          </Select>
          <button
            type="button"
            aria-pressed={availableOnly}
            onClick={() => setAvailableOnly((current) => !current)}
            className={cn(
              "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all",
              availableOnly
                ? "border-brand/40 bg-brand/15 text-brand shadow-sm shadow-brand/10"
                : "border-line-strong text-ink-muted hover:bg-hover hover:text-ink",
            )}
          >
            Available to me
          </button>
        </div>
      </div>

      {models.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No models match"
            description="Clear the search or switch category — part of the catalogue may also be closed to this account."
          />
        </div>
      ) : (
        /* `grid-cols-1` rather than relying on the implicit track: an implicit track is sized
           `auto`, so its minimum is the widest card's min-content — and a model card holds a long
           model id, a spec matrix and badges, which added up to ~545px. The cards ignored the
           343px a phone actually has and the page scrolled sideways. `grid-cols-1` compiles to
           `repeat(1, minmax(0, 1fr))`, which is the clamp that was missing.

           A plain block comment, not a brace-wrapped JSX comment: this is a ternary's alternative
           — an expression position — where `{ }` parses as a block, not as a comment slot. */
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {models.map((model) => {
            const vendor = resolveVendor(model.modelId, model.provider);
            const routedVia = titleCase(model.provider);
            return (
              <article
                key={model.id}
                className={cn(
                  "group relative flex flex-col justify-between gap-3.5 rounded-2xl border bg-gradient-to-b from-surface/90 to-surface/50 p-5 backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:shadow-pop",
                  model.available
                    ? "border-line/70 hover:border-brand/40 hover:shadow-brand/5"
                    : "border-line/50 opacity-80 hover:opacity-100 hover:border-amber/40 hover:shadow-amber/5",
                )}
              >
                {/* Ambient top highlight line */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute inset-x-0 top-0 h-[1.5px] rounded-t-2xl transition-opacity duration-300",
                    model.available
                      ? "bg-gradient-to-r from-transparent via-brand/45 to-transparent opacity-0 group-hover:opacity-100"
                      : "bg-gradient-to-r from-transparent via-amber/45 to-transparent opacity-0 group-hover:opacity-100",
                  )}
                />

                <header className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3.5 min-w-0">
                    <VendorMark vendor={vendor} />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-base font-semibold text-ink group-hover:text-ink-strong transition-colors">
                        {model.name}
                      </h3>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-md border border-line/70 bg-canvas/60 px-2 py-0.5 font-mono text-[11px] text-ink-muted group-hover:text-ink transition-colors">
                          <span className="truncate max-w-[160px] sm:max-w-[200px]">{model.modelId}</span>
                          <CopyButton
                            value={model.modelId}
                            compact
                            label={`Copy ${model.modelId}`}
                            toastMessage="Model id copied"
                          />
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <Badge tone={CATEGORY_TONES[model.category] ?? "neutral"} className="capitalize font-medium">
                      {titleCase(model.category)}
                    </Badge>
                    {model.available ? (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-brand">
                        <span className="relative flex size-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
                          <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
                        </span>
                        Available
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber">
                        <svg viewBox="0 0 16 16" fill="none" className="size-3" stroke="currentColor" strokeWidth="1.5">
                          <rect x="3" y="6" width="10" height="8" rx="1.5" />
                          <path d="M5 6V4a3 3 0 0 1 6 0v2" strokeLinecap="round" />
                        </svg>
                        {model.minPlanName}
                      </span>
                    )}
                  </div>
                </header>

                {model.description ? (
                  <p className="line-clamp-2 text-xs leading-relaxed text-ink-muted">
                    {model.description}
                  </p>
                ) : null}

                {model.capabilities.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {model.capabilities.map((capability) => (
                      <li
                        key={capability}
                        className="inline-flex items-center gap-1 rounded-md border border-line/60 bg-raised/40 px-2 py-0.5 text-[11px] text-ink-muted transition-colors group-hover:border-line-strong group-hover:text-ink"
                      >
                        <span className="size-1 rounded-full bg-brand/50" />
                        {capability}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* Specs Matrix: Context, Output limit, Pricing */}
                <div className="grid grid-cols-2 gap-2 rounded-xl border border-line/50 bg-canvas/40 p-2.5 sm:grid-cols-4">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">Context</span>
                    <span className="mt-0.5 font-mono text-xs font-semibold text-ink">{formatLimit(model.contextWindow)}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">Max Out</span>
                    <span className="mt-0.5 font-mono text-xs font-semibold text-ink">{formatLimit(model.maxOutputTokens)}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">Input / 1M</span>
                    <span className="mt-0.5 font-mono text-xs font-semibold text-ink">{formatPricePerMillion(model.inputPrice)}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">Output / 1M</span>
                    <span className="mt-0.5 font-mono text-xs font-semibold text-ink">{formatPricePerMillion(model.outputPrice)}</span>
                  </div>
                </div>

                <footer className="mt-auto flex items-center justify-between gap-3 border-t border-line/60 pt-3 text-[11px]">
                  <div className="flex items-center gap-1.5 min-w-0 truncate text-ink-muted">
                    <span className="size-1.5 rounded-full bg-line-strong" />
                    <span className="font-medium text-ink">{vendor.label}</span>
                    {vendor.label.toLowerCase() === model.provider.toLowerCase()
                      ? null
                      : <span className="truncate text-ink-faint">· via {routedVia}</span>}
                  </div>
                  {model.available ? (
                    <span className="inline-flex items-center gap-1 font-medium text-ink-faint group-hover:text-brand transition-colors">
                      Ready to route
                      <span className="transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                    </span>
                  ) : (
                    /*
                     * Names the purchase, not the tier the row is gated behind. `minPlan` may say
                     * `pro` or `business`, but neither can be bought — the only thing that clears
                     * any gate is the one-time Unlimited payment, and `planSatisfies` puts it
                     * above every `minPlan` in the catalogue. A "Needs Pro" badge would have sent
                     * users to /subscription looking for a plan that isn't on sale.
                     */
                    <Link
                      href="/subscription"
                      className="shrink-0 rounded-lg border border-amber/35 bg-amber/10 px-2.5 py-1 font-medium text-amber transition-all hover:bg-amber/20 hover:border-amber/50"
                    >
                      Unlock with Unlimited
                    </Link>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
