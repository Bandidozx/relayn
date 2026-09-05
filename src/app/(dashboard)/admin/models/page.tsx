import type { Metadata } from "next";
import { AdminModels } from "@/components/admin/admin-models";
import { requireAdmin } from "@/lib/auth/guards";
import { listAdminModelsPayload, listAdminProviders } from "@/server/services/admin-service";

export const metadata: Metadata = { title: "Admin · Models" };

export default async function AdminModelsPage() {
  await requireAdmin();
  // Providers are read here only so "Add model" can offer the ones a hand-added row may name —
  // a provider with no working credential cannot be probed, so it must not be offerable.
  const [payload, providers] = await Promise.all([listAdminModelsPayload(), listAdminProviders()]);

  return <AdminModels initial={payload.models} initialRemoved={payload.removed} providers={providers} />;
}
