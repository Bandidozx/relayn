import { cn } from "@/lib/cn";

const FIELD_BASE =
  "w-full rounded-lg border border-line-strong bg-canvas px-3 text-sm text-ink transition-colors placeholder:text-ink-faint hover:border-ink-faint/60 focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-rose";

export function Label({
  className,
  children,
  hint,
  ...rest
}: React.LabelHTMLAttributes<HTMLLabelElement> & { hint?: React.ReactNode }) {
  return (
    <label className={cn("flex items-baseline justify-between gap-3 pb-1.5", className)} {...rest}>
      <span className="text-xs font-medium tracking-wide text-ink-muted uppercase">{children}</span>
      {hint ? <span className="text-[11px] text-ink-faint">{hint}</span> : null}
    </label>
  );
}

/** Label + control + error/help text, so forms stay consistent and accessible. */
export function Field({
  label,
  htmlFor,
  error,
  help,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string | null;
  help?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor} hint={hint}>
        {label}
      </Label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="mt-1.5 text-xs text-rose">
          {error}
        </p>
      ) : help ? (
        <p id={`${htmlFor}-help`} className="mt-1.5 text-xs text-ink-faint">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD_BASE, "h-9.5", className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD_BASE, "min-h-24 resize-y py-2.5 leading-relaxed", className)} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={cn(FIELD_BASE, "h-9.5 cursor-pointer appearance-none pr-8", className)}
        {...rest}
      >
        {children}
      </select>
      <svg
        viewBox="0 0 16 16"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-faint"
        aria-hidden
      >
        <path d="M4 6.5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function Checkbox({
  className,
  label,
  id,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-muted">
      <input
        id={id}
        type="checkbox"
        className={cn(
          "mt-0.5 size-4 shrink-0 cursor-pointer appearance-none rounded border border-line-strong bg-canvas transition-colors checked:border-brand checked:bg-brand",
          "checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><path d=%22M3.5 8.5l3 3 6-6%22 fill=%22none%22 stroke=%22%2304120e%22 stroke-width=%222.2%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/></svg>')] checked:bg-center checked:bg-no-repeat",
          className,
        )}
        {...rest}
      />
      <span>{label}</span>
    </label>
  );
}
