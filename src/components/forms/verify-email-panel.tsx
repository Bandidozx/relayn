"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiClientError } from "@/lib/client/api";

type State = "verifying" | "done" | "failed" | "missing";

export function VerifyEmailPanel({ token }: { token: string }) {
  const [state, setState] = useState<State>(token ? "verifying" : "missing");
  const [message, setMessage] = useState("");
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    api
      .post("/api/auth/verify-email", { token })
      .then(() => setState("done"))
      .catch((error: unknown) => {
        setMessage(
          error instanceof ApiClientError ? error.message : "Verification could not be completed.",
        );
        setState("failed");
      });
  }, [token]);

  return (
    <div className="panel p-6 text-center">
      {state === "verifying" ? (
        <>
          <h1 className="text-lg font-semibold text-ink">Verifying your email…</h1>
          <p className="mt-2 text-sm text-ink-muted">One moment.</p>
        </>
      ) : state === "done" ? (
        <>
          <span className="mx-auto grid size-10 place-items-center rounded-xl border border-brand/30 bg-brand/10 text-brand" aria-hidden>
            ✓
          </span>
          <h1 className="mt-3 text-lg font-semibold text-ink">Email verified</h1>
          <p className="mt-2 text-sm text-ink-muted">Your address is confirmed.</p>
          <Link href="/login" className="mt-4 inline-block text-xs text-brand hover:underline">
            Continue to sign in →
          </Link>
        </>
      ) : (
        <>
          <h1 className="text-lg font-semibold text-ink">
            {state === "missing" ? "Link incomplete" : "Verification failed"}
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            {state === "missing"
              ? "This page needs the token from your verification email."
              : message}
          </p>
          <Link href="/login" className="mt-4 inline-block text-xs text-brand hover:underline">
            Back to sign in →
          </Link>
        </>
      )}
    </div>
  );
}
