import type { Metadata } from "next";
import { AdminTickets } from "@/components/admin/admin-tickets";
import { requireAdmin } from "@/lib/auth/guards";
import { listAdminTickets } from "@/server/services/admin-service";

export const metadata: Metadata = { title: "Admin · Tickets" };

export default async function AdminTicketsPage() {
  await requireAdmin();
  const tickets = await listAdminTickets();

  return <AdminTickets initial={tickets} />;
}
