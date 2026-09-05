/**
 * Catalogue sync — pulls what each configured upstream currently serves into `models`.
 *
 * Aggregator gateways change their model list without notice, so hand-seeding them goes
 * stale immediately. This asks every provider that implements `listModels()` what it has
 * and upserts the answer.
 *
 * What it will and will not overwrite is the important part. On **create** it fills the row
 * in full, inferring a category and a minimum plan from the model id and its price. On
 * **update** it refreshes only facts the upstream owns — the identifier sent upstream, the
 * context window, and pricing when the upstream publishes it (that is the number cost
 * accounting must agree with). It never touches `enabled`, `minPlan`, `description` or
 * `sortOrder`, because those are operator decisions made in Admin → Models.
 *
 * Models that vanished upstream are reported as `stale` and left alone: disabling someone's
 * catalogue entry on the strength of one API call is not this function's call to make.
 *
 * Rows marked `manual` are skipped entirely — not updated, not reported as stale. They exist
 * because an operator typed them in, often for a model the upstream serves but does not list, so
 * both "refresh it from the listing" and "the listing has dropped it" are the wrong answer.
 *
 * Ids in `removed_models` are skipped too, and for a sharper reason: without that check a deletion
 * would not survive. An id the operator deleted is, by definition, one this function no longer
 * recognises, so the branch below would create it again and the row would be back — same name,
 * same prices — with nothing in the UI to explain why. Skipping is what makes "delete" mean it.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { listProviders } from "@/lib/providers/registry";
import type { ModelProvider, ProviderModelInfo } from "@/lib/providers/types";
import type { PlanId } from "@/lib/plans";

export interface ProviderSyncResult {
  provider: string;
  label: string;
  discovered: number;
  created: number;
  updated: number;
  /** Hand-added rows the upstream also lists. Left exactly as the operator wrote them. */
  preserved: number;
  /** Ids the upstream lists that an operator deleted. Skipped so the deletion sticks. */
  suppressed: number;
  /** Catalogue rows for this provider that the upstream no longer lists. */
  stale: string[];
  /** Present when the provider could not be reached at all. */
  error?: string;
}

export interface SyncSummary {
  results: ProviderSyncResult[];
  created: number;
  updated: number;
  preserved: number;
  suppressed: number;
  /** Providers that are registered but have no credential, so they were skipped. */
  skipped: string[];
}

/**
 * Category from the model id. Aggregators rarely tag their models, and the dashboard's
 * category filter has to put a row somewhere, so this reads the id — the only signal on
 * offer. An admin can correct it; a wrong guess is cosmetic, unlike a wrong price.
 */
export function inferCategory(modelId: string): string {
  const id = modelId.toLowerCase();
  if (/embed|bge|gte-|e5-/.test(id)) return "embeddings";
  if (/vision|-vl|vl-|image|multimodal|omni/.test(id)) return "vision";
  if (/cod(er|ex|ing)|dev-|starcoder|qwen.*coder/.test(id)) return "coding";
  if (/reason|thinking|-r1|r1-|\bo[134]\b|deepthink|nemotron|muse/.test(id)) return "reasoning";
  return "chat";
}

/**
 * Minimum plan from output price, in USD per 1M tokens. A free model is free to everyone;
 * anything metered is kept off the Free tier so a 250K-token allocation cannot be spent on
 * an expensive upstream by an account that never paid. Deliberately conservative — widening
 * access is one dropdown in Admin → Models, walking back a surprise bill is not.
 */
export function inferMinPlan(outputPrice: number | undefined): PlanId {
  if (outputPrice === undefined || outputPrice <= 0) return "free";
  if (outputPrice <= 2) return "pro";
  return "business";
}

/** Human-readable name from an id like `deepseek-ai/DeepSeek-V4-Flash`. */
export function deriveName(modelId: string): string {
  const tail = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
  const cleaned = tail.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned
    .split(" ")
    .map((word) => (/[A-Z]/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

function capabilities(info: ProviderModelInfo, category: string): string {
  const tags = ["streaming"];
  if (category === "vision") tags.push("vision");
  if (category === "reasoning") tags.push("reasoning");
  if (category !== "embeddings") tags.push("tools");
  if ((info.contextWindow ?? 0) >= 200_000) tags.push("long-context");
  return tags.join(",");
}

async function syncOne(provider: ModelProvider, sortBase: number): Promise<ProviderSyncResult> {
  const result: ProviderSyncResult = {
    provider: provider.id,
    label: provider.label,
    discovered: 0,
    created: 0,
    updated: 0,
    preserved: 0,
    suppressed: 0,
    stale: [],
  };

  let listed: ProviderModelInfo[];
  try {
    listed = await provider.listModels!();
  } catch (error) {
    result.error = error instanceof Error ? error.message : "Catalogue request failed.";
    return result;
  }

  result.discovered = listed.length;
  const [existing, deleted] = await Promise.all([
    prisma.aiModel.findMany({
      where: { provider: provider.id },
      select: { modelId: true, manual: true },
    }),
    prisma.removedModel.findMany({
      where: { provider: provider.id },
      select: { modelId: true },
    }),
  ]);
  const known = new Set(existing.map((row) => row.modelId));
  // Hand-added rows are the operator's, not the upstream's. Sync must not rewrite the
  // `upstreamModel` or the prices someone typed in, and must not report them as stale when the
  // upstream does not list them — being unlisted is the usual reason a row was added by hand.
  const manual = new Set(existing.filter((row) => row.manual).map((row) => row.modelId));
  // Ids an operator deleted. There is no row to protect here — the row is gone, which is why
  // this list has to exist at all.
  const removed = new Set(deleted.map((row) => row.modelId));
  const seen = new Set<string>();

  let index = 0;
  for (const info of listed) {
    // The public identifier is namespaced by provider so two upstreams serving the same
    // model name cannot collide on `models.modelId`, which is unique. `upstreamModel` keeps
    // the id the upstream actually expects.
    const modelId = `${provider.id}/${info.id}`;
    seen.add(modelId);
    const category = inferCategory(info.id);

    const upstreamOwned = {
      provider: provider.id,
      upstreamModel: info.id,
      ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
      ...(info.maxOutputTokens !== undefined ? { maxOutputTokens: info.maxOutputTokens } : {}),
      ...(info.inputPrice !== undefined ? { inputPrice: info.inputPrice } : {}),
      ...(info.outputPrice !== undefined ? { outputPrice: info.outputPrice } : {}),
    };

    if (manual.has(modelId)) {
      result.preserved++;
    } else if (removed.has(modelId)) {
      // Checked before `known` as well as before the create: a suppressed id should have no row,
      // but if one exists anyway it is not sync's to refresh — restore is the way back.
      result.suppressed++;
    } else if (known.has(modelId)) {
      await prisma.aiModel.update({ where: { modelId }, data: upstreamOwned });
      result.updated++;
    } else {
      await prisma.aiModel.create({
        data: {
          modelId,
          name: info.name ?? deriveName(info.id),
          category,
          // Nothing synthesised. The sentence this used to generate was byte-identical on every
          // synced row and only repeated what the card already shows — provider in the footer,
          // upstream id in the copy field — so it read as filler and buried the real metrics.
          // Upstreams that publish genuine prose still get it; everything else renders nothing.
          description: info.description ?? "",
          capabilities: capabilities(info, category),
          minPlan: inferMinPlan(info.outputPrice),
          enabled: true,
          sortOrder: sortBase + index,
          ...upstreamOwned,
        },
      });
      result.created++;
    }
    index++;
  }

  result.stale = [...known]
    .filter((modelId) => !seen.has(modelId) && !manual.has(modelId) && !removed.has(modelId))
    .sort();
  return result;
}

/**
 * Syncs every configured provider that can list its catalogue, or just the ones named.
 * Providers without a credential are skipped rather than reported as failures — an
 * unconfigured provider is a deployment choice, not an error.
 */
export async function syncProviderCatalogue(only?: string[]): Promise<SyncSummary> {
  const wanted = only && only.length > 0 ? new Set(only) : null;
  const candidates = (await listProviders()).filter(
    (provider) =>
      typeof provider.listModels === "function" && (!wanted || wanted.has(provider.id)),
  );

  const skipped = candidates.filter((provider) => !provider.isConfigured()).map((p) => p.id);
  const runnable = candidates.filter((provider) => provider.isConfigured());

  // Sequential on purpose: each provider's rows get a contiguous `sortOrder` band, and a
  // handful of upstreams is not worth the interleaved-write complexity.
  const results: ProviderSyncResult[] = [];
  let band = 100;
  for (const provider of runnable) {
    results.push(await syncOne(provider, band));
    band += 100;
  }

  return {
    results,
    created: results.reduce((sum, entry) => sum + entry.created, 0),
    updated: results.reduce((sum, entry) => sum + entry.updated, 0),
    preserved: results.reduce((sum, entry) => sum + entry.preserved, 0),
    suppressed: results.reduce((sum, entry) => sum + entry.suppressed, 0),
    skipped,
  };
}
