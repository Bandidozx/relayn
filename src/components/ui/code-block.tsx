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
    <div className={cn("overflow-hidden rounded-xl border border-line bg-canvas", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line bg-raised/50 px-3 py-2">
        <span className="truncate font-mono text-[11px] text-ink-faint">
          {filename ?? language ?? "shell"}
        </span>
        <CopyButton value={code} toastMessage="Snippet copied" />
      </div>
      <pre
        className="overflow-auto px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink-muted"
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
      <div role="tablist" aria-label="Code language" className="mb-2.5 flex flex-wrap gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === current.id}
            onClick={() => setActive(tab.id)}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-xs transition-colors",
              tab.id === current.id
                ? "bg-brand/12 text-brand"
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
