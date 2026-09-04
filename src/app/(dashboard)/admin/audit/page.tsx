import type { Metadata } from "next";
import { AdminAudit } from "@/components/admin/admin-audit";
import { requireAdmin } from "@/lib/auth/guards";
import { listAuditLog } from "@/server/services/admin-service";

export const metadata: Metadata = { title: "Admin · Audit log" };

export default async function AdminAuditPage() {
  await requireAdmin();
  const initial = await listAuditLog({ page: 1, pageSize: 25 });

  return <AdminAudit initial={initial} />;
}
