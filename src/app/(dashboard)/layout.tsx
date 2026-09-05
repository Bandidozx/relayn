/**
 * Server layout for every signed-in page.
 *
 * This is the single authorisation point for the dashboard: unauthenticated visitors are
 * redirected here, before any child page renders or queries. Child pages still scope
 * every query by `user.id` (see `src/lib/auth/guards.ts`) so a missed check in one place
 * can never expose another tenant's rows.
 */
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getRequestSubscription, quotaFrom } from "@/lib/usage/accounting";
import { planOf } from "@/lib/plans";
import { DashboardShell, type ShellQuota, type ShellUser } from "@/components/layout/shell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  // The CSRF cookie that client writes echo back is issued by `src/proxy.ts`;
  // a layout is not allowed to set cookies.

  const quota = quotaFrom(await getRequestSubscription(session.user.id), session.user);

  const user: ShellUser = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
    avatarUrl: session.user.avatarUrl,
  };

  const shellQuota: ShellQuota = {
    plan: quota.plan,
    planName: planOf(quota.plan).name,
    allocation: quota.allocation,
    used: quota.used,
    remaining: quota.remaining,
    percentUsed: quota.percentUsed,
    renewalDate: quota.renewalDate.toISOString(),
    unlimited: quota.unlimited,
    unlimitedByPayment: quota.unlimitedByPayment,
    unlimitedByRole: quota.unlimitedByRole,
  };

  return (
    <DashboardShell user={user} quota={shellQuota}>
      {children}
    </DashboardShell>
  );
}
