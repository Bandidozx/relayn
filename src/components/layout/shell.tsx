"use client";

/**
 * Dashboard shell: fixed sidebar on desktop, slide-over drawer on mobile, sticky header.
 *
 * All data arrives as plain props from the server layout — this component never queries,
 * so there is exactly one authorisation point (the layout's `requireUser()`).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Brand } from "@/components/layout/brand";
import { NAV_ITEMS, SECONDARY_NAV_ITEMS, type NavItem } from "@/components/layout/nav";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/cn";
import { formatCompact, formatDate, formatPercent } from "@/lib/format";

export interface ShellUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
}

export interface ShellQuota {
  plan: string;
  planName: string;
  allocation: number;
  used: number;
  remaining: number;
  percentUsed: number;
  renewalDate: string;
  /** No token ceiling. The card shows lifetime usage instead of a progress bar. */
  unlimited: boolean;
}

function initials(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
        active
          ? "bg-brand/10 font-medium text-brand"
          : "text-ink-muted hover:bg-hover hover:text-ink",
      )}
    >
      {active ? (
        <span className="absolute top-1/2 -left-2.5 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" aria-hidden />
      ) : null}
      {item.icon}
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function QuotaCard({ quota }: { quota: ShellQuota }) {
  const pct = Math.min(100, Math.max(0, quota.percentUsed));
  const tone = pct >= 90 ? "bg-rose" : pct >= 70 ? "bg-amber" : "bg-brand";

  return (
    <div className="rounded-xl border border-line bg-raised/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">
          {quota.unlimited ? "Access" : "Token allocation"}
        </p>
        <span className="rounded-full border border-line-strong px-1.5 py-0.5 text-[10px] text-ink-muted">
          {quota.planName}
        </span>
      </div>

      {quota.unlimited ? (
        // No bar and no reset date: there is no ceiling to fill and nothing to renew. The
        // lifetime total is the only usage figure such an account has.
        <>
          <p className="mt-2 text-sm font-medium text-brand">Unlimited</p>
          <p className="numeric mt-1 text-[10.5px] text-ink-faint">
            {formatCompact(quota.used)} tokens used all-time
          </p>
          <p className="mt-0.5 text-[10.5px] text-ink-faint">Permanent — no renewal</p>
        </>
      ) : (
        <>
          <p className="numeric mt-2 text-sm text-ink">
            {formatCompact(quota.remaining)}
            <span className="text-ink-faint"> / {formatCompact(quota.allocation)} left</span>
          </p>

          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Monthly token allocation used"
          >
            <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${pct}%` }} />
          </div>

          <div className="mt-2 flex items-center justify-between text-[10.5px] text-ink-faint">
            <span className="numeric">{formatPercent(pct, 0)} used</span>
            <span>resets {formatDate(quota.renewalDate)}</span>
          </div>
        </>
      )}

      <Link
        href="/subscription"
        className="mt-2.5 block rounded-lg border border-line-strong py-1.5 text-center text-[11px] text-ink-muted transition-colors hover:bg-hover hover:text-ink"
      >
        {quota.unlimited ? "View access" : "Manage plan"}
      </Link>
    </div>
  );
}

function AccountCard({ user, onSignOut, signingOut }: { user: ShellUser; onSignOut: () => void; signingOut: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="relative" onClick={(event) => event.stopPropagation()}>
      {open ? (
        <div
          role="menu"
          className="panel animate-rise absolute bottom-full left-0 z-30 mb-2 w-full overflow-hidden p-1 shadow-pop"
        >
          <Link
            href="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block rounded-lg px-2.5 py-2 text-xs text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          >
            Profile settings
          </Link>
          <Link
            href="/subscription"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block rounded-lg px-2.5 py-2 text-xs text-ink-muted transition-colors hover:bg-hover hover:text-ink"
          >
            Subscription
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={onSignOut}
            disabled={signingOut}
            className="mt-0.5 block w-full rounded-lg border-t border-line px-2.5 py-2 text-left text-xs text-rose transition-colors hover:bg-rose/10 disabled:opacity-60"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-raised/60 p-2.5 text-left transition-colors hover:bg-hover"
      >
        <span
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand/15 text-[11px] font-semibold text-brand"
          aria-hidden
        >
          {initials(user.name, user.email)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-ink">{user.name}</span>
          <span className="block truncate text-[11px] text-ink-faint">{user.email}</span>
        </span>
        <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ink-faint" aria-hidden>
          <path d="M5 10l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export function DashboardShell({
  user,
  quota,
  children,
}: {
  user: ShellUser;
  quota: ShellQuota;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Close the drawer whenever navigation completes.
  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  async function signOut() {
    setSigningOut(true);
    try {
      await api.post("/api/auth/logout");
      router.replace("/login");
      router.refresh();
    } catch {
      toast.error("Sign out failed", "Please try again.");
      setSigningOut(false);
    }
  }

  const items = NAV_ITEMS;
  const secondary = SECONDARY_NAV_ITEMS.filter(
    (item) => !item.adminOnly || user.role === "admin",
  );

  const isActive = (href: string) =>
    pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));

  const sidebar = (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="px-1.5 pt-1.5">
        <Brand showTagline />
      </div>

      <nav aria-label="Dashboard" className="flex-1 space-y-0.5 overflow-y-auto pl-2.5">
        {items.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}

        <p className="px-2.5 pt-4 pb-1 text-[10px] font-medium tracking-wider text-ink-faint uppercase">
          Reference
        </p>
        {secondary.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
      </nav>

      <div className="space-y-2.5">
        <QuotaCard quota={quota} />
        <AccountCard user={user} onSignOut={signOut} signingOut={signingOut} />
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-surface lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-80 lg:hidden">
          <div
            className="animate-fade absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <aside
            className="animate-rise absolute inset-y-0 left-0 w-70 max-w-[85vw] border-r border-line bg-surface shadow-pop"
            aria-label="Navigation"
          >
            {sidebar}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-line bg-canvas/85 px-4 py-3 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            className="grid size-8.5 shrink-0 place-items-center rounded-lg border border-line-strong transition-colors hover:bg-hover lg:hidden"
          >
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight text-ink">
              Relayn Gateway
            </p>
            <p className="hidden truncate text-[11px] text-ink-faint sm:block">
              One OpenAI-compatible endpoint in front of every model you use.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden max-w-50 truncate text-xs text-ink-muted md:block">
              {user.email}
            </span>
            {user.role === "admin" ? (
              <Link
                href="/admin"
                className="hidden rounded-lg border border-violet/30 bg-violet/10 px-2.5 py-1.5 text-[11px] text-violet transition-colors hover:bg-violet/20 sm:block"
              >
                Admin
              </Link>
            ) : null}
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-60"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6">
          <div className="mx-auto w-full max-w-[88rem] space-y-5">{children}</div>
        </main>
      </div>
    </div>
  );
}
