/**
 * Display descriptor for a quota.
 *
 * Extracted from the components so the "does the dashboard show Unlimited correctly?"
 * requirement is a unit test over plain data rather than a DOM assertion. Every surface that
 * shows quota — sidebar card, dashboard hero, subscription page, runway card — renders from
 * this one descriptor, so they cannot disagree about what an unlimited account looks like.
 *
 * No JSX, no formatting locale, no React: strings and numbers only.
 */
import { formatCompact } from "@/lib/format";
import type { QuotaStatus } from "@/lib/usage/accounting";

export interface QuotaDisplay {
  /** True when the account has no token ceiling. Drives every branch below. */
  unlimited: boolean;
  /** Headline figure: "Unlimited" or a compact remaining count. */
  primary: string;
  /** Sub-label: "no token ceiling" or "of 5M left". */
  secondary: string;
  /** Null when there is no bar to draw — an unlimited account has no meaningful percentage. */
  percent: number | null;
  /** True when a finite allocation is nearly gone; always false when unlimited. */
  warning: boolean;
  /** True when a finite allocation is spent; always false when unlimited. */
  exhausted: boolean;
  /** What to say about the next date. Unlimited accounts have no renewal to announce. */
  renewalLabel: string | null;
}

/** Fraction of the allocation at which the sidebar turns amber. */
const WARN_AT = 0.85;

export function describeQuota(quota: QuotaStatus): QuotaDisplay {
  if (quota.unlimited) {
    return {
      unlimited: true,
      primary: "Unlimited",
      secondary: "no token ceiling",
      percent: null,
      warning: false,
      exhausted: false,
      // Permanent access has no renewal date; announcing one would imply it can lapse.
      renewalLabel: null,
    };
  }

  return {
    unlimited: false,
    primary: formatCompact(quota.remaining),
    secondary: `of ${formatCompact(quota.allocation)} left`,
    percent: Math.round(quota.percentUsed),
    warning: quota.percentUsed >= WARN_AT * 100 && !quota.exhausted,
    exhausted: quota.exhausted,
    renewalLabel: "resets",
  };
}
