import type { Metadata } from "next";
import { LoginForm } from "@/components/forms/login-form";
import { isGoogleOAuthConfigured } from "@/lib/auth/oauth/google";
import { OAUTH_ERROR_MESSAGES } from "@/lib/auth/oauth/types";

export const metadata: Metadata = { title: "Sign in" };

/** `next` lets a protected route bounce the user back where they were headed. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  // Only same-site relative paths are honoured, so `?next=` cannot be an open redirect.
  const safeNext = next && /^\/(?!\/)[\w\-/?=&.]*$/.test(next) ? next : "/dashboard";
  // Looked up in a fixed table rather than rendered: `?error=` is attacker-controlled text.
  const message = error ? (OAUTH_ERROR_MESSAGES[error] ?? null) : null;

  return (
    <LoginForm nextPath={safeNext} googleEnabled={isGoogleOAuthConfigured()} initialError={message} />
  );
}
