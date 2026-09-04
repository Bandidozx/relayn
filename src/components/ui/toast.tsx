"use client";

/**
 * Toast notifications. Every mutation in the dashboard reports its outcome through
 * `useToast()`, so success and failure are always visible without a page reload.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  push: (toast: Omit<Toast, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, { bar: string; icon: string; glyph: string }> = {
  success: { bar: "bg-brand", icon: "text-brand", glyph: "✓" },
  error: { bar: "bg-rose", icon: "text-rose", glyph: "!" },
  info: { bar: "bg-sky", icon: "text-sky", glyph: "i" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), toast.tone === "error" ? 7000 : 4200),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      dismiss,
      success: (title, description) => push({ tone: "success", title, description }),
      error: (title, description) => push({ tone: "error", title, description }),
      info: (title, description) => push({ tone: "info", title, description }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-3 bottom-3 z-100 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:items-end"
      >
        {toasts.map((toast) => {
          const tone = TONE_STYLES[toast.tone];
          return (
            <div
              key={toast.id}
              role={toast.tone === "error" ? "alert" : "status"}
              className="panel animate-rise pointer-events-auto flex w-full items-start gap-3 overflow-hidden py-3 pr-3 pl-0 shadow-pop sm:w-90"
            >
              <span className={cn("h-full w-1 self-stretch", tone.bar)} aria-hidden />
              <span
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-line text-[11px] font-bold",
                  tone.icon,
                )}
                aria-hidden
              >
                {tone.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{toast.title}</p>
                {toast.description ? (
                  <p className="mt-0.5 text-xs leading-relaxed break-words text-ink-muted">
                    {toast.description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
                className="-mt-0.5 rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
              >
                <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>.");
  return context;
}
