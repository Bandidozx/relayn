"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { AuthDivider, GoogleSignInButton } from "@/components/forms/google-sign-in";
import { api, ApiClientError } from "@/lib/client/api";

const RULES = [
  { test: (value: string) => value.length >= 10, label: "At least 10 characters" },
  { test: (value: string) => /[a-zA-Z]/.test(value), label: "Contains a letter" },
  { test: (value: string) => /[0-9]/.test(value), label: "Contains a number" },
];

export function RegisterForm({ googleEnabled = false }: { googleEnabled?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setErrors({});
    setFormError(null);

    try {
      await api.post("/api/auth/register", { name, email, password });
      toast.success("Account created", "Your Free plan allocation is ready to use.");
      router.replace("/dashboard");
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
      <h1 className="text-lg font-semibold tracking-tight text-ink">Create your account</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Start on the Free plan — 250K tokens a month, no card required.
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
            {/* Same route as sign-in: with OAuth there is no separate "register" leg — the
                first successful handshake for an unknown address creates the account. */}
            <GoogleSignInButton label="Sign up with Google" />
          </div>
          <AuthDivider label="or use your email" />
        </>
      ) : null}

      <div className={googleEnabled ? "space-y-4" : "mt-5 space-y-4"}>
        <Field label="Name" htmlFor="name" error={errors["name"]}>
          <Input
            id="name"
            name="name"
            autoComplete="name"
            required
            autoFocus
            placeholder="Ada Lovelace"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={Boolean(errors["name"])}
          />
        </Field>

        <Field label="Email" htmlFor="email" error={errors["email"]}>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(errors["email"])}
          />
        </Field>

        <Field label="Password" htmlFor="password" error={errors["password"]}>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            placeholder="At least 10 characters"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(errors["password"])}
          />
          <ul className="mt-2 grid gap-1">
            {RULES.map((rule) => {
              const met = rule.test(password);
              return (
                <li
                  key={rule.label}
                  className={`flex items-center gap-1.5 text-[11px] ${met ? "text-brand" : "text-ink-faint"}`}
                >
                  <span aria-hidden>{met ? "✓" : "•"}</span>
                  {rule.label}
                </li>
              );
            })}
          </ul>
        </Field>
      </div>

      <Button type="submit" variant="primary" size="lg" loading={loading} className="mt-5 w-full">
        {loading ? "Creating account…" : "Create account"}
      </Button>

      <p className="mt-4 text-center text-xs text-ink-muted">
        Already registered?{" "}
        <Link href="/login" className="text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
