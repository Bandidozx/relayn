/**
 * Admin section layout.
 *
 * This is the server-side gate for every `/admin/*` page — the sidebar link being hidden for
 * non-admins is cosmetic, this redirect is the actual control. The `/api/admin/*` routes each
 * call `requireAdmin()` independently, so hitting them directly is blocked too.
 */
import { redirect } from "next/navigation";
import { AdminTabs } from "@/components/admin/admin-tabs";
import { PageHeader } from "@/components/ui/card";
import { getSession } from "@/lib/auth/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.user.role !== "admin") redirect("/dashboard");

  return (
    <>
      <PageHeader
        title="Admin"
        description="Operator view across every account. Actions here are written to the audit log with your email attached."
      />
      <AdminTabs />
      {children}
    </>
  );
}
