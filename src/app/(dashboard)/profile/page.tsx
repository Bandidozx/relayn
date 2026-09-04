import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfilePanel } from "@/components/profile/profile-panel";
import { PageHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { isGoogleOAuthConfigured } from "@/lib/auth/oauth/google";
import { OAUTH_ERROR_MESSAGES } from "@/lib/auth/oauth/types";
import { getProfile } from "@/server/services/profile-service";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string; error?: string }>;
}) {
  const { user } = await requireUser();
  const [profile, { linked, error }] = await Promise.all([getProfile(user.id), searchParams]);
  // requireUser() already proved the row exists; this covers a delete racing the render.
  if (!profile) notFound();

  return (
    <>
      <PageHeader
        title="Profile"
        description="Your account, credentials and the switch that turns all of this off."
      />
      <ProfilePanel
        initial={profile}
        googleEnabled={isGoogleOAuthConfigured()}
        // Both come back from the OAuth callback as short codes. Looked up in a fixed table,
        // never rendered from the URL, so `?error=` cannot inject text onto the page.
        linkedNotice={linked === "google" ? "Google is now connected to this account." : null}
        linkError={error ? (OAUTH_ERROR_MESSAGES[error] ?? null) : null}
      />
    </>
  );
}
