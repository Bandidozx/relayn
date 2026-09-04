import type { Metadata } from "next";
import { RegisterForm } from "@/components/forms/register-form";
import { isGoogleOAuthConfigured } from "@/lib/auth/oauth/google";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return <RegisterForm googleEnabled={isGoogleOAuthConfigured()} />;
}
