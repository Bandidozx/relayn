"use client";

/** Sub-navigation for the admin section. Active state comes from the real pathname. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/models", label: "Models" },
  { href: "/admin/providers", label: "Providers" },
  { href: "/admin/tickets", label: "Tickets" },
  { href: "/admin/audit", label: "Audit log" },
];

export function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections" className="flex flex-wrap gap-1 border-b border-line pb-2">
      {TABS.map((tab) => {
        const active = tab.href === "/admin" ? pathname === "/admin" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs transition-colors",
              active
                ? "bg-brand/12 text-brand"
                : "text-ink-muted hover:bg-hover hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
