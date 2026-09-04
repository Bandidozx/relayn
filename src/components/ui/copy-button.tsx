"use client";

/**
 * Copy-to-clipboard controls. `navigator.clipboard` is unavailable on insecure origins, so
 * a textarea + `execCommand` fallback keeps the button honest instead of silently failing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/toast";

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "Copy",
  className,
  toastMessage,
  compact = false,
}: {
  value: string;
  label?: string;
  className?: string;
  toastMessage?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const handle = useCallback(async () => {
    const ok = await copyText(value);
    if (!ok) {
      toast.error("Copy failed", "Your browser blocked clipboard access. Select the text manually.");
      return;
    }
    setCopied(true);
    if (toastMessage) toast.success(toastMessage);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [value, toast, toastMessage]);

  return (
    <button
      type="button"
      onClick={handle}
      aria-label={copied ? "Copied" : label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-raised text-xs transition-colors hover:bg-hover",
        compact ? "size-7 justify-center" : "px-2.5 py-1.5",
        copied && "border-brand/40 text-brand",
        className,
      )}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
          <path
            d="M3.5 8.5l3 3 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
          <rect x="5.5" y="5.5" width="8" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M10.5 3.5A2 2 0 0 0 8.5 2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 1.5 1.94"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      )}
      {compact ? null : <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}
