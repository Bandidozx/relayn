import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/forms/reset-password-form";

export const metadata: Metadata = { title: "New password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={token ?? ""} />;
}
