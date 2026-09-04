"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { api, ApiClientError } from "@/lib/client/api";

interface ForgotResponse {
  sent: boolean;
  message: string;
  /** Only present in development, when no mail transport is configured. */
  devToken?: string;
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<ForgotResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setFormError(null);
    try {
      setResult(await api.post<ForgotResponse>("/api/auth/forgot-password", { email }));
    } catch (error) {
      setFormError(
        error instanceof ApiClientError ? error.message : "Something went wrong. Try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <div className="panel p-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Check your inbox</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">{result.message}</p>

        {result.devToken ? (
          <div className="mt-4 rounded-lg border border-amber/30 bg-amber/8 p-3">
            <p className="text-[11px] font-medium tracking-wide text-amber uppercase">
              Development only
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              No mail transport is configured (<span className="numeric">EMAIL_TRANSPORT</span>), so
              the link is shown here instead of being emailed.
            </p>
            <Link
              href={`/reset-password?token=${encodeURIComponent(result.devToken)}`}
              className="mt-2 inline-block text-xs text-brand hover:underline"
            >
              Continue to reset password →
            </Link>
          </div>
        ) : null}

        <Link
          href="/login"
          className="mt-5 inline-block text-xs text-ink-muted hover:text-brand"
        >
          ← Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel p-6" noValidate>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Reset your password</h1>
      <p className="mt-1 text-sm text-ink-muted">
        We&apos;ll send a single-use link that expires in an hour.
      </p>

      {formError ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-rose/30 bg-rose/10 px-3 py-2 text-xs text-rose"
        >
          {formError}
        </p>
      ) : null}

      <div className="mt-5">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
      </div>

      <Button type="submit" variant="primary" size="lg" loading={loading} className="mt-5 w-full">
        Send reset link
      </Button>

      <p className="mt-4 text-center text-xs text-ink-muted">
        <Link href="/login" className="hover:text-brand">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
