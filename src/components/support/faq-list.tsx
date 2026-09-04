"use client";

/**
 * FAQ accordion. Content is static and honest about what this deployment does and does not
 * do — no promises about billing or SLAs that the code cannot keep.
 */
import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";

export interface FaqEntry {
  question: string;
  answer: React.ReactNode;
}

export function FaqList({ entries }: { entries: FaqEntry[] }) {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <Card>
      <CardHeader
        title="Frequently asked"
        description="The questions that come up most often, answered against how this gateway actually behaves."
      />
      <ul className="divide-y divide-line">
        {entries.map((entry, index) => {
          const expanded = open === index;
          return (
            <li key={entry.question}>
              <h3>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : index)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-hover"
                >
                  <span className="text-sm text-ink">{entry.question}</span>
                  <svg
                    viewBox="0 0 16 16"
                    className={cn(
                      "size-3.5 shrink-0 text-ink-faint transition-transform",
                      expanded && "rotate-180",
                    )}
                    aria-hidden
                  >
                    <path
                      d="M4 6.5l4 4 4-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </h3>
              {expanded ? (
                <div className="px-4 pb-4 text-xs leading-relaxed text-ink-muted">
                  {entry.answer}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
