"use client";

/**
 * Light/dark switch.
 *
 * Deliberately stateless. The current theme lives in one place — the `data-theme` attribute on
 * `<html>`, set before first paint by the script in `src/app/layout.tsx` — and this button reads it
 * from the DOM at click time rather than mirroring it into React. A mirrored copy would have to be
 * initialised on the server, which cannot know the answer, and every such component pays for that
 * with a wrong first paint.
 *
 * Which icon shows is therefore a CSS question too (`.theme-icon-to-light` / `.theme-icon-to-dark`
 * in `globals.css`), so the button looks right in server-rendered HTML before any JavaScript runs.
 */
import { cn } from "@/lib/cn";

/** Shared with the boot script in the root layout. Changing it invalidates stored preferences. */
const STORAGE_KEY = "relayn-theme";

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <circle cx="8" cy="8" r="3.25" fill="currentColor" />
      <path
        d="M8 1v1.75M8 13.25V15M1 8h1.75M13.25 8H15M3.05 3.05l1.24 1.24M11.71 11.71l1.24 1.24M12.95 3.05l-1.24 1.24M4.29 11.71l-1.24 1.24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <path
        d="M13.5 10.2A5.75 5.75 0 0 1 6.1 2.6a5.75 5.75 0 1 0 7.4 7.6Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  function toggle() {
    const root = document.documentElement;
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode, blocked storage: the switch still works for this page view, it just will
      // not be remembered. Failing silently is right — there is nothing the visitor can do.
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        "grid size-8.5 shrink-0 place-items-center rounded-lg border border-line-strong text-ink-muted transition-colors hover:bg-hover hover:text-ink",
        className,
      )}
    >
      {/* Visible in dark: the action is "switch to light". */}
      <span className="theme-icon-to-light">
        <SunIcon />
        <span className="sr-only">Switch to light theme</span>
      </span>
      {/* Visible in light. */}
      <span className="theme-icon-to-dark">
        <MoonIcon />
        <span className="sr-only">Switch to dark theme</span>
      </span>
    </button>
  );
}
