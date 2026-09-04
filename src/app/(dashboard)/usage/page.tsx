import type { Metadata } from "next";
import { UsageExplorer, type UsageFilters } from "@/components/usage/usage-explorer";
import { PageHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { listUsage } from "@/server/services/usage-service";

export const metadata: Metadata = { title: "Usage logs" };

/** Seeds the client explorer so a link like /usage?status=error lands pre-filtered. */
function seedFilters(params: Record<string, string | undefined>): Partial<UsageFilters> {
  const seed: Partial<UsageFilters> = {};
  if (params.search) seed.search = params.search.slice(0, 200);
  if (params.modelId) seed.modelId = params.modelId.slice(0, 200);
  if (params.apiKeyId) seed.apiKeyId = params.apiKeyId.slice(0, 60);
  if (params.status === "success" || params.status === "error") seed.status = params.status;
  return seed;
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireUser();
  const raw = await searchParams;
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    flat[key] = Array.isArray(value) ? value[0] : value;
  }

  const seed = seedFilters(flat);
  const initial = await listUsage(user.id, {
    page: 1,
    pageSize: 25,
    sort: "createdAt",
    direction: "desc",
    search: seed.search,
    modelId: seed.modelId,
    apiKeyId: seed.apiKeyId,
    status: seed.status || undefined,
    from: undefined,
    to: undefined,
  });

  return (
    <>
      <PageHeader
        title="Usage logs"
        description="Every request the gateway handled for your account, successful or not. Click a row for the full record."
      />
      <UsageExplorer initial={initial} initialFilters={seed} />
    </>
  );
}
