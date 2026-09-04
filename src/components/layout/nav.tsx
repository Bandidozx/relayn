"use client";

/**
 * Navigation definitions + icons for the dashboard shell. Kept in one place so the
 * sidebar, the mobile drawer and the account menu can never drift apart.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  /** Shown to admins only. */
  adminOnly?: boolean;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5 shrink-0" aria-hidden>
      {children}
    </svg>
  );
}

export const OverviewIcon = (
  <Icon>
    <path d="M3 11.5h5V17H3zM3 3h5v5.5H3zM12 3h5v5.5h-5zM12 11.5h5V17h-5z" {...stroke} />
  </Icon>
);

export const UsageIcon = (
  <Icon>
    <path d="M3 16.5V13M7 16.5V8M11 16.5v-5.5M15 16.5V4.5" {...stroke} />
  </Icon>
);

export const KeyIcon = (
  <Icon>
    <circle cx="7" cy="7" r="3.5" {...stroke} />
    <path d="M9.6 9.6L16 16M13.4 13l1.6-1.6M11.4 11l1.6-1.6" {...stroke} />
  </Icon>
);

export const ModelIcon = (
  <Icon>
    <path d="M10 2.5l6.5 3.75v7.5L10 17.5 3.5 13.75v-7.5z" {...stroke} />
    <path d="M10 10l6.5-3.75M10 10v7.5M10 10L3.5 6.25" {...stroke} />
  </Icon>
);

export const IntegrationIcon = (
  <Icon>
    <path d="M7.5 3.5v4M12.5 3.5v4" {...stroke} />
    <path d="M5 7.5h10v3a5 5 0 0 1-10 0z" {...stroke} />
    <path d="M10 15.5v2" {...stroke} />
  </Icon>
);

export const PlanIcon = (
  <Icon>
    <rect x="2.5" y="4.5" width="15" height="11" rx="2.5" {...stroke} />
    <path d="M2.5 8.5h15M6 12.5h3" {...stroke} />
  </Icon>
);

export const SupportIcon = (
  <Icon>
    <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h9A2.5 2.5 0 0 1 17 6.5v5A2.5 2.5 0 0 1 14.5 14H8l-4 3v-3.4A2.5 2.5 0 0 1 3 11.5z" {...stroke} />
  </Icon>
);

export const ProfileIcon = (
  <Icon>
    <circle cx="10" cy="7" r="3" {...stroke} />
    <path d="M4 16.5a6 6 0 0 1 12 0" {...stroke} />
  </Icon>
);

export const AdminIcon = (
  <Icon>
    <path d="M10 2.5l6 2.5v5c0 3.2-2.4 6-6 7.5-3.6-1.5-6-4.3-6-7.5V5z" {...stroke} />
    <path d="M7.5 10l1.8 1.8L13 8" {...stroke} />
  </Icon>
);

export const DocsIcon = (
  <Icon>
    <path d="M5 3.5h7l3 3v10H5z" {...stroke} />
    <path d="M11.5 3.5v3.5H15M7.5 10.5h5M7.5 13h5" {...stroke} />
  </Icon>
);

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: OverviewIcon },
  { href: "/usage", label: "Usage Logs", icon: UsageIcon },
  { href: "/api-keys", label: "API Keys", icon: KeyIcon },
  { href: "/models", label: "Models", icon: ModelIcon },
  { href: "/integrations", label: "Integrations", icon: IntegrationIcon },
  { href: "/subscription", label: "Subscription", icon: PlanIcon },
  { href: "/support", label: "Support", icon: SupportIcon },
  { href: "/profile", label: "Profile", icon: ProfileIcon },
];

export const SECONDARY_NAV_ITEMS: NavItem[] = [
  { href: "/docs", label: "Documentation", icon: DocsIcon },
  { href: "/admin", label: "Admin", icon: AdminIcon, adminOnly: true },
];
