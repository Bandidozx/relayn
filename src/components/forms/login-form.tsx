"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { AuthDivider, GoogleSignInButton } from "@/components/forms/google-sign-in";
import { api, ApiClientError } from "@/lib/client/api";

export function LoginForm({
  nextPath,
  googleEnabled = false,
  initialError = null,
}: {
  nextPath: string;
  /** False when the deployment has no Google client credentials — the button is hidden, not broken. */
  googleEnabled?: boolean;
  /** Wording for a `?error=` code bounced back by the OAuth callback. */
  initialError?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setErrors({});
    setFormError(null);

    try {
      await api.post("/api/auth/login", { email, password });
      toast.success("Signed in");
      // `refresh` re-runs the server layout so the shell picks up the new session.
      router.replace(nextPath);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.details) setErrors(error.details);
        setFormError(error.message);
      } else {
        setFormError("Something went wrong. Try again.");
      }
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel p-6" noValidate>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Sign in to Relayn</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {googleEnabled
          ? "Continue with Google, or use the email and password for your gateway account."
          : "Use the email and password for your gateway account."}
      </p>

      {formError ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-rose/30 bg-rose/10 px-3 py-2 text-xs text-rose"
        >
          {formError}
        </p>
      ) : null}

      {googleEnabled ? (
        <>
          <div className="mt-5">
            <GoogleSignInButton nextPath={nextPath} />
          </div>
          <AuthDivider label="or sign in with email" />
        </>
      ) : null}

      <div className={googleEnabled ? "space-y-4" : "mt-5 space-y-4"}>
        <Field label="Email" htmlFor="email" error={errors["email"]}>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(errors["email"])}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          error={errors["password"]}
          hint={
            <Link href="/forgot-password" className="text-ink-muted hover:text-brand">
              Forgot?
            </Link>
          }
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••••"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(errors["password"])}
          />
        </Field>
      </div>

      <Button type="submit" variant="primary" size="lg" loading={loading} className="mt-5 w-full">
        {loading ? "Signing in…" : "Sign in"}
      </Button>

      <p className="mt-4 text-center text-xs text-ink-muted">
        No account yet?{" "}
        <Link href="/register" className="text-brand hover:underline">
          Create one
        </Link>
      </p>
    </form>
  );
}
