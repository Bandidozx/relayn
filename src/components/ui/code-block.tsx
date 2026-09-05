"use client";

/**
 * Code block with a copy button and optional language tabs. Used on /integrations and
 * /docs, where every snippet must be runnable as-is against this deployment.
 */
import { useState } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/cn";

export function CodeBlock({
  code,
  language,
  filename,
  className,
  maxHeight = "26rem",
}: {
  code: string;
  language?: string;
  filename?: string;
  className?: string;
  maxHeight?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-line/70 bg-code shadow-[inset_0_1px_0_var(--sheen),0_12px_28px_-8px_var(--shade)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-line/60 bg-surface/40 px-3.5 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-rose/70" />
            <span className="size-2.5 rounded-full bg-amber/70" />
            <span className="size-2.5 rounded-full bg-brand/70" />
          </div>
          <span className="ml-1 truncate font-mono text-[11px] text-ink-faint">
            {filename ?? language ?? "shell"}
          </span>
        </div>
        <CopyButton value={code} toastMessage="Snippet copied" />
      </div>
      <pre
        className="overflow-auto p-4 font-mono text-[12.5px] leading-relaxed text-ink/90 selection:bg-brand/20"
        style={{ maxHeight }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

export interface CodeTab {
  id: string;
  label: string;
  language: string;
  code: string;
  filename?: string;
}

export function CodeTabs({ tabs, className }: { tabs: CodeTab[]; className?: string }) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  if (!current) return null;

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label="Code language"
        className="mb-3 inline-flex flex-wrap items-center gap-1 rounded-xl border border-line/60 bg-surface/60 p-1 backdrop-blur-md"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === current.id}
            onClick={() => setActive(tab.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150",
              tab.id === current.id
                ? "bg-brand/15 text-brand shadow-sm"
                : "text-ink-muted hover:bg-hover hover:text-ink",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <CodeBlock
        code={current.code}
        language={current.language}
        {...(current.filename ? { filename: current.filename } : {})}
      />
    </div>
  );
}
