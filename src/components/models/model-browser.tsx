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
        <div role="tablist" aria-label="Model category" className="flex flex-wrap gap-1">
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
                  "rounded-lg px-3 py-1.5 text-xs transition-colors",
                  tab === category
                    ? "bg-brand/12 font-medium text-brand"
                    : "text-ink-muted hover:bg-hover hover:text-ink",
                )}
              >
                {tab === "all" ? "All models" : titleCase(tab)}
                <span className="numeric ml-1.5 text-ink-faint">{count}</span>
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
              "rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
              availableOnly
                ? "border-brand/40 bg-brand/12 text-brand"
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
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {models.map((model) => {
            const vendor = resolveVendor(model.modelId, model.provider);
            const routedVia = titleCase(model.provider);
            return (
              <article
                key={model.id}
                className={cn(
                  "panel relative flex flex-col gap-3 p-4 transition-colors",
                  model.available ? "hover:border-line-strong" : "opacity-75",
                )}
              >
                {/*
                 * Status stripe along the top edge.
                 *
                 * It encodes the only status this page actually knows — whether the caller's plan
                 * may call the model. Per-model provider health is not measured anywhere, so there
                 * is deliberately no "degraded" state to draw; inventing one would be a made-up
                 * number wearing a colour.
                 *
                 * The radius is the card's minus its 1px border so the stripe follows the inner
                 * corner. That avoids `overflow-hidden` on the card, which would clip the copy
                 * button's toast.
                 */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-x-0 top-0 h-[3px] rounded-t-[calc(var(--radius-card)-1px)]",
                    model.available ? "bg-brand/70" : "bg-amber/70",
                  )}
                />

                <header className="flex items-start gap-3">
                  <VendorMark vendor={vendor} />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-semibold text-ink">{model.name}</h3>
                    <div className="mt-1 flex items-center gap-1.5">
                      <code className="numeric truncate text-[11px] text-ink-faint">
                        {model.modelId}
                      </code>
                      <CopyButton
                        value={model.modelId}
                        compact
                        label={`Copy ${model.modelId}`}
                        toastMessage="Model id copied"
                      />
                    </div>
                  </div>
                  <Badge tone={CATEGORY_TONES[model.category] ?? "neutral"} className="shrink-0">
                    {titleCase(model.category)}
                  </Badge>
                </header>

                {model.description ? (
                  <p className="text-xs leading-relaxed text-ink-muted">{model.description}</p>
                ) : null}

                {model.capabilities.length > 0 ? (
                  <ul className="flex flex-wrap gap-1">
                    {model.capabilities.map((capability) => (
                      <li
                        key={capability}
                        className="rounded-md border border-line bg-raised/60 px-1.5 py-0.5 text-[10.5px] text-ink-faint"
                      >
                        {capability}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-faint">Context</dt>
                    <dd className="numeric text-ink">{formatLimit(model.contextWindow)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-faint">Max out</dt>
                    <dd className="numeric text-ink">{formatLimit(model.maxOutputTokens)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-faint">Input</dt>
                    <dd className="numeric text-ink">{formatPricePerMillion(model.inputPrice)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-faint">Output</dt>
                    <dd className="numeric text-ink">{formatPricePerMillion(model.outputPrice)}</dd>
                  </div>
                </dl>

                {/*
                 * Doubles as the text equivalent of the vendor tile, which is `aria-hidden`.
                 * "via <provider>" is dropped when the two names are the same word, so a card
                 * never reads "OpenAI · via Openai" or "Madefaka · via Madefaka".
                 */}
                <footer className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3">
                  <span className="min-w-0 truncate text-[11px] text-ink-faint">
                    <span className="text-ink-muted">{vendor.label}</span>
                    {vendor.label.toLowerCase() === model.provider.toLowerCase()
                      ? null
                      : ` · via ${routedVia}`}
                  </span>
                  {model.available ? (
                    <Badge tone="brand" dot className="shrink-0">
                      Available
                    </Badge>
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
                      className="shrink-0 rounded-lg border border-amber/35 bg-amber/10 px-2 py-1 text-[11px] text-amber transition-opacity hover:opacity-85"
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
