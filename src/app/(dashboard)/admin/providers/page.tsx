import type { Metadata } from "next";
import { AdminProviders } from "@/components/admin/admin-providers";
import { requireAdmin } from "@/lib/auth/guards";
import { listAdminProviders } from "@/server/services/admin-service";

export const metadata: Metadata = { title: "Admin · Providers" };

export default async function AdminProvidersPage() {
  await requireAdmin();
  const providers = await listAdminProviders();

  return <AdminProviders initial={providers} />;
}
