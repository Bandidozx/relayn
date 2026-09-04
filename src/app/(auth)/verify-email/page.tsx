import type { Metadata } from "next";
import { VerifyEmailPanel } from "@/components/forms/verify-email-panel";

export const metadata: Metadata = { title: "Verify email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <VerifyEmailPanel token={token ?? ""} />;
}
