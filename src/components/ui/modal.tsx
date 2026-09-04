"use client";

/**
 * Modal + confirmation dialog.
 *
 * Handles the accessibility details once: Escape to close, scroll lock, focus moved into
 * the dialog on open and restored on close, a focus trap over Tab, and
 * `role="dialog" aria-modal`.
 *
 * One rule holds all of that together: the effect below runs on an *open transition*, never
 * on a render. Callers pass `onClose` as an inline arrow, so its identity changes on every
 * parent render — and a parent re-renders on every keystroke of a controlled input it owns.
 * If that identity reached the dependency array, typing one character would tear the effect
 * down (its cleanup restores focus to whatever opened the dialog) and set it up again
 * (focusing the first control in the panel), so the caret would leave the field after each
 * character. `onClose` is therefore read through a ref and the keydown handler is stable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton, type ButtonVariant } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  size = "md",
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  closeOnBackdrop?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => setMounted(true), []);

  /**
   * Latest `onClose` without making it a dependency. Assigned on every render (no dep array)
   * so Escape always calls the current closure, even though the listener is installed once.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    // `mounted` gates this too: on the first render the portal does not exist yet, so there
    // would be nothing to focus. The early return has no cleanup, so no focus is stolen.
    if (!open || !mounted) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    const timer = setTimeout(() => {
      // Prefer the first control in the dialog *body* — the field the user came to fill in —
      // over the close button that happens to sit first in DOM order.
      const node =
        bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (node ?? panelRef.current)?.focus();
    }, 20);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = overflow;
      restoreTo.current?.focus?.();
    };
  }, [open, mounted, handleKeyDown]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-90 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div
        className="animate-fade absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className={cn(
          "panel animate-rise relative flex max-h-[92dvh] w-full flex-col overflow-hidden shadow-pop",
          "rounded-b-none sm:rounded-b-[var(--radius-card)]",
          size === "sm" ? "sm:max-w-md" : size === "lg" ? "sm:max-w-3xl" : "sm:max-w-lg",
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id="modal-title" className="text-sm font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">{description}</p>
            ) : null}
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </IconButton>
        </header>

        {children ? (
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {children}
          </div>
        ) : null}

        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-raised/40 px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** Destructive-action confirmation. `confirmPhrase` forces the user to type a value. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  confirmVariant = "danger",
  loading = false,
  confirmPhrase,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  confirmVariant?: ButtonVariant;
  loading?: boolean;
  confirmPhrase?: string;
}) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const blocked = Boolean(confirmPhrase) && typed.trim() !== confirmPhrase;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      closeOnBackdrop={!loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} loading={loading} disabled={blocked}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-ink-muted">
        <div>{message}</div>
        {confirmPhrase ? (
          <div>
            <label htmlFor="confirm-phrase" className="block pb-1.5 text-xs text-ink-faint">
              Type <span className="numeric text-ink">{confirmPhrase}</span> to continue
            </label>
            <input
              id="confirm-phrase"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              className="h-9.5 w-full rounded-lg border border-line-strong bg-canvas px-3 text-sm focus:border-brand focus:outline-none"
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
