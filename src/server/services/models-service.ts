/**
 * Model catalogue.
 *
 * `listModelsForUser` returns every enabled model but marks which ones the caller's plan
 * may actually call, so the UI can show an honest "upgrade to unlock" state instead of
 * hiding the catalogue. The gateway performs the real authorisation check independently
 * in `resolveModel` — this function is presentation only.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { effectivePlan, planOf, planSatisfies } from "@/lib/plans";
import { getRequestSubscription, type AccountRef } from "@/lib/usage/accounting";

export interface ModelView {
  id: string;
  modelId: string;
  name: string;
  provider: string;
  category: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPrice: number;
  outputPrice: number;
  capabilities: string[];
  minPlan: string;
  minPlanName: string;
  enabled: boolean;
  /** True when the caller's current plan is allowed to call this model. */
  available: boolean;
}

export interface ModelCatalogue {
  plan: string;
  planName: string;
  models: ModelView[];
  categories: string[];
  providers: string[];
  availableCount: number;
}

export function splitCapabilities(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Drops the sentence `syncProviderCatalogue` used to write for every model it discovered.
 *
 * It was byte-identical on every synced card, which turned the catalogue grid into a wall of
 * grey prose, and its second half — "pricing and tier are editable in Admin → Models" — is an
 * operator instruction with no business on a user-facing page. The generator no longer writes
 * it, but rows created before that change still carry it, so it is filtered on read rather than
 * migrated: a description an operator typed themselves has to survive untouched, and matching
 * the exact generated sentence is the only reliable way to tell the two apart.
 */
export function visibleDescription(value: string): string {
  return value.includes("Discovered by catalogue sync") ? "" : value.trim();
}

export async function listModelsForUser(account: AccountRef): Promise<ModelCatalogue> {
  const subscription = await getRequestSubscription(account.id);
  // The effective plan, so what the catalogue shows as unlocked is what the gateway will actually
  // serve. Rendering a padlock the gateway ignores is the same bug as the reverse.
  const plan = effectivePlan(subscription.plan, account.role);

  const rows = await prisma.aiModel.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const models: ModelView[] = rows.map((row) => ({
    id: row.id,
    modelId: row.modelId,
    name: row.name,
    provider: row.provider,
    category: row.category,
    description: visibleDescription(row.description),
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    inputPrice: row.inputPrice,
    outputPrice: row.outputPrice,
    capabilities: splitCapabilities(row.capabilities),
    minPlan: row.minPlan,
    minPlanName: planOf(row.minPlan).name,
    enabled: row.enabled,
    available: planSatisfies(plan, row.minPlan),
  }));

  return {
    plan,
    planName: planOf(plan).name,
    models,
    categories: [...new Set(models.map((model) => model.category))].sort(),
    providers: [...new Set(models.map((model) => model.provider))].sort(),
    availableCount: models.filter((model) => model.available).length,
  };
}

export interface PublicCatalogueSummary {
  total: number;
  providers: string[];
  categories: Array<{ category: string; count: number }>;
  /** A few representative model ids, for the landing page's copy-paste example. */
  sampleModelId: string | null;
  maxContextWindow: number;
}

/**
 * Counts for the unauthenticated landing page. Enabled models only, and no pricing or
 * plan-tier detail — a visitor with no account should learn the shape of the catalogue,
 * not enumerate what a paying tier gets.
 */
export async function publicCatalogueSummary(): Promise<PublicCatalogueSummary> {
  const rows = await prisma.aiModel.findMany({
    where: { enabled: true },
    select: { modelId: true, provider: true, category: true, contextWindow: true, minPlan: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);

  return {
    total: rows.length,
    providers: [...new Set(rows.map((row) => row.provider))].sort(),
    categories: [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    sampleModelId: rows.find((row) => row.minPlan === "free")?.modelId ?? rows[0]?.modelId ?? null,
    maxContextWindow: rows.reduce((max, row) => Math.max(max, row.contextWindow), 0),
  };
}
