import type { Metadata } from "next";
import { AdminUsers } from "@/components/admin/admin-users";
import { requireAdmin } from "@/lib/auth/guards";
import { listUsers } from "@/server/services/admin-service";

export const metadata: Metadata = { title: "Admin · Users" };

export default async function AdminUsersPage() {
  // The layout already gated this, but the guard is repeated so the page cannot be
  // rendered through some future path that skips the layout.
  const { user } = await requireAdmin();
  const initial = await listUsers({ page: 1, pageSize: 25 });

  return <AdminUsers initial={initial} currentUserId={user.id} />;
}
