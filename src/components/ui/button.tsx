import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-brand-ink hover:bg-brand-strong active:bg-brand-strong disabled:hover:bg-brand font-semibold",
  secondary: "bg-raised text-ink border border-line-strong hover:bg-hover disabled:hover:bg-raised",
  ghost: "text-ink-muted hover:bg-hover hover:text-ink",
  outline: "border border-line-strong text-ink hover:bg-hover hover:border-ink-faint",
  danger: "bg-rose/12 text-rose border border-rose/35 hover:bg-rose/20",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-9.5 px-4 text-sm gap-2 rounded-lg",
  lg: "h-11 px-5 text-sm gap-2 rounded-xl",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Rendered before the label; hidden while `loading`. */
  icon?: React.ReactNode;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3.5 animate-spin-slow", className)} aria-hidden>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M8 1.5A6.5 6.5 0 0 1 14.5 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-55",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

/** Square icon-only button; `label` becomes the accessible name. */
export function IconButton({
  label,
  variant = "ghost",
  className,
  children,
  ...rest
}: Omit<ButtonProps, "size" | "icon"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-grid size-8 shrink-0 place-items-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-55",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
