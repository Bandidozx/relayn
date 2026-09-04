"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/client/api";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!token) {
    return (
      <div className="panel p-6">
        <h1 className="text-lg font-semibold text-ink">Link incomplete</h1>
        <p className="mt-2 text-sm text-ink-muted">
          This page needs the token from your reset link.
        </p>
        <Link href="/forgot-password" className="mt-4 inline-block text-xs text-brand hover:underline">
          Request a new link →
        </Link>
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    setFormError(null);

    if (password !== confirm) {
      setErrors({ confirm: "Passwords do not match." });
      return;
    }

    setLoading(true);
    try {
      await api.post("/api/auth/reset-password", { token, password });
      toast.success("Password updated", "Sign in with your new password.");
      router.replace("/login");
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
      <h1 className="text-lg font-semibold tracking-tight text-ink">Choose a new password</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Every existing session is signed out once this is saved.
      </p>

      {formError ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-rose/30 bg-rose/10 px-3 py-2 text-xs text-rose"
        >
          {formError}
        </p>
      ) : null}

      <div className="mt-5 space-y-4">
        <Field label="New password" htmlFor="password" error={errors["password"]} help="At least 10 characters, with a letter and a number.">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(errors["password"])}
          />
        </Field>

        <Field label="Confirm password" htmlFor="confirm" error={errors["confirm"]}>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            aria-invalid={Boolean(errors["confirm"])}
          />
        </Field>
      </div>

      <Button type="submit" variant="primary" size="lg" loading={loading} className="mt-5 w-full">
        Update password
      </Button>
    </form>
  );
}
