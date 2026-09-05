"use client";

/**
 * Profile: identity, connected sign-in providers, password rotation and account deletion.
 *
 * Email is deliberately read-only. Changing it would need a verify-new-address round trip and
 * this build has no mail transport, so the field states that instead of silently accepting an
 * edit that could lock someone out of their own account.
 *
 * Two cards change shape depending on `hasPassword`: an account that only ever signed in
 * through a provider has no current password to prove, so it is offered "set a password" and
 * confirms deletion by retyping its email address.
 */
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { GoogleMark } from "@/components/forms/google-sign-in";
import { Checkbox, Field, Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { formatDateTime, formatNumber, titleCase } from "@/lib/format";
import type { ProfileView } from "@/server/services/profile-service";

interface ProfileResponse {
  profile: ProfileView;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function ProfilePanel({
  initial,
  googleEnabled = false,
  linkedNotice = null,
  linkError = null,
}: {
  initial: ProfileView;
  /** False when the deployment has no Google client credentials. */
  googleEnabled?: boolean;
  linkedNotice?: string | null;
  linkError?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [profile, setProfile] = useState(initial);

  const [identity, setIdentity] = useState({
    name: initial.name,
    avatarUrl: initial.avatarUrl ?? "",
  });
  const [identityErrors, setIdentityErrors] = useState<Record<string, string>>({});
  const [savingIdentity, setSavingIdentity] = useState(false);

  const [passwords, setPasswords] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    signOutEverywhere: true,
  });
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [savingPassword, setSavingPassword] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Provider id currently being removed, so only its own button shows a spinner. */
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const identityDirty =
    identity.name.trim() !== profile.name || identity.avatarUrl.trim() !== (profile.avatarUrl ?? "");

  async function saveIdentity() {
    const name = identity.name.trim();
    if (name.length === 0) {
      setIdentityErrors({ name: "Name is required." });
      return;
    }
    const avatarUrl = identity.avatarUrl.trim();
    if (avatarUrl !== "" && !avatarUrl.startsWith("https://")) {
      setIdentityErrors({ avatarUrl: "Avatar URL must be an https:// link." });
      return;
    }

    setSavingIdentity(true);
    setIdentityErrors({});
    try {
      const data = await api.patch<ProfileResponse>("/api/profile", { name, avatarUrl });
      setProfile(data.profile);
      setIdentity({ name: data.profile.name, avatarUrl: data.profile.avatarUrl ?? "" });
      toast.success("Profile updated");
      // The sidebar account card is server-rendered from the same row.
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError) {
        setIdentityErrors(error.details ?? {});
        if (!error.details) toast.error("Update failed", error.message);
      } else {
        toast.error("Update failed", "Please try again.");
      }
    } finally {
      setSavingIdentity(false);
    }
  }

  async function savePassword() {
    if (passwords.newPassword !== passwords.confirmPassword) {
      setPasswordErrors({ confirmPassword: "The two new passwords do not match." });
      return;
    }
    if (passwords.newPassword.length < 10) {
      setPasswordErrors({ newPassword: "Password must be at least 10 characters." });
      return;
    }

    setSavingPassword(true);
    setPasswordErrors({});
    try {
      await api.patch("/api/profile/password", {
        // Omitted entirely for a provider-only account: there is no current password, and
        // the server decides that from the stored hash rather than from this field.
        ...(profile.hasPassword ? { currentPassword: passwords.currentPassword } : {}),
        newPassword: passwords.newPassword,
        signOutEverywhere: passwords.signOutEverywhere,
      });
      const wasFirst = !profile.hasPassword;
      setProfile((current) => ({ ...current, hasPassword: true }));
      setPasswords({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
        signOutEverywhere: true,
      });
      toast.success(
        wasFirst ? "Password set" : "Password changed",
        passwords.signOutEverywhere
          ? "Other devices have been signed out."
          : "Other sessions were left signed in.",
      );
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError) {
        setPasswordErrors(error.details ?? {});
        if (!error.details) toast.error("Could not change password", error.message);
      } else {
        toast.error("Could not change password", "Please try again.");
      }
    } finally {
      setSavingPassword(false);
    }
  }

  async function confirmDelete() {
    // A provider-only account has no password to re-enter, so it retypes its email instead.
    if (profile.hasPassword && deletePassword.length === 0) {
      setDeleteError("Enter your password to confirm.");
      return;
    }
    if (!profile.hasPassword && deleteConfirmEmail.trim().length === 0) {
      setDeleteError("Type your email address to confirm.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete("/api/profile", {
        ...(profile.hasPassword
          ? { password: deletePassword }
          : { confirmEmail: deleteConfirmEmail.trim() }),
        confirm: "DELETE",
      });
      // The server has already revoked every session; go somewhere public.
      router.replace("/login?deleted=1");
      router.refresh();
    } catch (error) {
      setDeleteError(
        error instanceof ApiClientError ? error.message : "Could not delete the account.",
      );
      setDeleting(false);
    }
  }

  /**
   * Disconnecting is refused server-side when it would leave no way in; the button is
   * disabled here for the same reason so the state is visible before the click.
   */
  async function disconnect(provider: string) {
    setDisconnecting(provider);
    try {
      const data = await api.delete<ProfileResponse>(`/api/profile/connections/${provider}`);
      setProfile(data.profile);
      toast.success(`${titleCase(provider)} disconnected`);
      router.refresh();
    } catch (error) {
      toast.error(
        "Could not disconnect",
        error instanceof ApiClientError ? error.message : "Please try again.",
      );
    } finally {
      setDisconnecting(null);
    }
  }

  const facts: [string, React.ReactNode][] = [
    ["Account created", formatDateTime(profile.createdAt)],
    ["Last sign-in", profile.lastLoginAt ? formatDateTime(profile.lastLoginAt) : "—"],
    ["Email verified", profile.emailVerifiedAt ? formatDateTime(profile.emailVerifiedAt) : "Not verified"],
    ["Access", profile.planName],
    ["Active sessions", formatNumber(profile.activeSessions)],
    ["Active API keys", formatNumber(profile.activeKeys)],
    ["Requests logged", formatNumber(profile.totalRequests)],
    ["User id", <span className="numeric text-xs">{profile.id}</span>],
  ];

  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <Card>
          <CardHeader
            title="Identity"
            description="How your account is labelled across the dashboard and the audit log."
            action={<StatusBadge status={profile.status} />}
          />
          <CardBody className="space-y-4">
            <div className="flex items-center gap-3.5">
              {identity.avatarUrl.startsWith("https://") ? (
                // Remote host is user-supplied, so this stays a plain <img> rather than
                // next/image, which would need every hostname allow-listed up front.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={identity.avatarUrl}
                  alt=""
                  className="size-14 rounded-full border border-line object-cover"
                />
              ) : (
                <div className="grid size-14 place-items-center rounded-full border border-line bg-raised text-sm font-medium text-ink-muted">
                  {initials(identity.name || profile.email)}
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{profile.name}</p>
                <p className="truncate text-xs text-ink-faint">{profile.email}</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Badge tone={profile.role === "admin" ? "violet" : "neutral"}>
                    {titleCase(profile.role)}
                  </Badge>
                  <Badge tone="neutral">{profile.planName}</Badge>
                </div>
              </div>
            </div>

            <Field label="Display name" htmlFor="profile-name" error={identityErrors.name}>
              <Input
                id="profile-name"
                value={identity.name}
                maxLength={120}
                autoComplete="name"
                onChange={(event) =>
                  setIdentity((current) => ({ ...current, name: event.target.value }))
                }
              />
            </Field>

            <Field
              label="Avatar URL"
              htmlFor="profile-avatar"
              error={identityErrors.avatarUrl}
              help="An https:// image link. Leave empty to fall back to your initials — there is no file upload in this build."
            >
              <Input
                id="profile-avatar"
                value={identity.avatarUrl}
                maxLength={500}
                inputMode="url"
                placeholder="https://…"
                onChange={(event) =>
                  setIdentity((current) => ({ ...current, avatarUrl: event.target.value }))
                }
              />
            </Field>

            <Field
              label="Email"
              htmlFor="profile-email"
              help="Read-only. Changing it needs a confirm-new-address email, and no mail transport is configured here."
            >
              <Input id="profile-email" value={profile.email} readOnly disabled />
            </Field>

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!identityDirty || savingIdentity}
                onClick={() =>
                  setIdentity({ name: profile.name, avatarUrl: profile.avatarUrl ?? "" })
                }
              >
                Reset
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={savingIdentity}
                disabled={!identityDirty}
                onClick={saveIdentity}
              >
                Save changes
              </Button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Account details"
            description="Read-only facts, straight from the database row."
          />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {facts.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
                  <dd className="numeric mt-0.5 truncate text-sm text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            {!profile.emailVerifiedAt ? (
              <p className="mt-4 rounded-xl border border-amber/30 bg-amber/8 px-3.5 py-3 text-[11px] leading-relaxed text-ink-muted">
                This address is unverified. The verification flow exists at{" "}
                <span className="numeric text-ink">/verify-email</span> and consumes a token from the
                database — with no mail transport configured, the token is written to the server log
                on registration instead of being emailed.
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Connected accounts"
          description="Identity providers that can sign in to this account, keyed on the provider's own account id rather than on your email."
        />
        <CardBody className="space-y-3">
          {linkedNotice ? (
            <p className="rounded-xl border border-brand/30 bg-brand/8 px-3.5 py-2.5 text-xs text-ink-muted">
              {linkedNotice}
            </p>
          ) : null}
          {linkError ? (
            <p
              role="alert"
              className="rounded-xl border border-rose/30 bg-rose/10 px-3.5 py-2.5 text-xs text-rose"
            >
              {linkError}
            </p>
          ) : null}

          {profile.connections.length === 0 ? (
            <p className="text-xs leading-relaxed text-ink-muted">
              No provider is connected. Your password is the only way into this account.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {profile.connections.map((connection) => {
                // Removing the last sign-in method on a passwordless account is refused by
                // the server; disabling it here makes that visible before the click.
                const onlyWayIn = !profile.hasPassword && profile.connections.length === 1;
                return (
                  <li
                    key={connection.provider}
                    className="flex items-center justify-between gap-3 px-3.5 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {connection.provider === "google" ? <GoogleMark className="size-5" /> : null}
                      <div className="min-w-0">
                        <p className="truncate text-sm text-ink">
                          {titleCase(connection.provider)}
                          {connection.email ? (
                            <span className="text-ink-faint"> · {connection.email}</span>
                          ) : null}
                        </p>
                        <p className="mt-0.5 text-[11px] text-ink-faint">
                          Connected {formatDateTime(connection.createdAt)}
                          {connection.lastLoginAt
                            ? ` · last used ${formatDateTime(connection.lastLoginAt)}`
                            : " · not used to sign in yet"}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={disconnecting === connection.provider}
                      disabled={onlyWayIn || disconnecting !== null}
                      title={
                        onlyWayIn
                          ? "Set a password first — this is currently the only way you can sign in."
                          : undefined
                      }
                      onClick={() => disconnect(connection.provider)}
                    >
                      Disconnect
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {googleEnabled && !profile.connections.some((c) => c.provider === "google") ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-ink-faint">
                Connecting Google adds a second way to sign in. It does not change your password.
              </p>
              {/* A navigation, not a fetch — the handshake leaves the site. `link=1` tells the
                  start route to attach the identity to this account instead of signing in. */}
              <Link
                href="/api/auth/oauth/google?link=1"
                prefetch={false}
                className="inline-flex h-8 items-center gap-2 rounded-lg border border-line-strong px-3 text-xs font-medium text-ink transition-colors hover:border-ink-faint hover:bg-hover"
              >
                <GoogleMark />
                Connect Google
              </Link>
            </div>
          ) : null}
          {!googleEnabled && profile.connections.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-ink-faint">
              No identity provider is configured on this deployment. An operator enables Google
              sign-in by setting <span className="numeric text-ink">GOOGLE_OAUTH_CLIENT_ID</span> and{" "}
              <span className="numeric text-ink">GOOGLE_OAUTH_CLIENT_SECRET</span>.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <Card>
          <CardHeader
            title={profile.hasPassword ? "Change password" : "Set a password"}
            description={
              profile.hasPassword
                ? "Passwords are stored as scrypt hashes — we verify the current one rather than reading it."
                : "This account signs in through a provider and has no password yet. Adding one gives you a second way in."
            }
          />
          <CardBody className="space-y-4">
            {profile.hasPassword ? (
              <Field
                label="Current password"
                htmlFor="current-password"
                error={passwordErrors.currentPassword}
              >
                <Input
                  id="current-password"
                  type="password"
                  value={passwords.currentPassword}
                  autoComplete="current-password"
                  onChange={(event) =>
                    setPasswords((current) => ({ ...current, currentPassword: event.target.value }))
                  }
                />
              </Field>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="New password"
                htmlFor="new-password"
                error={passwordErrors.newPassword}
                help="At least 10 characters, with a letter and a number."
              >
                <Input
                  id="new-password"
                  type="password"
                  value={passwords.newPassword}
                  autoComplete="new-password"
                  onChange={(event) =>
                    setPasswords((current) => ({ ...current, newPassword: event.target.value }))
                  }
                />
              </Field>
              <Field
                label="Repeat new password"
                htmlFor="confirm-password"
                error={passwordErrors.confirmPassword}
              >
                <Input
                  id="confirm-password"
                  type="password"
                  value={passwords.confirmPassword}
                  autoComplete="new-password"
                  onChange={(event) =>
                    setPasswords((current) => ({ ...current, confirmPassword: event.target.value }))
                  }
                />
              </Field>
            </div>
            <Checkbox
              id="sign-out-everywhere"
              checked={passwords.signOutEverywhere}
              label={
                <span className="text-xs leading-relaxed">
                  Sign out my other {profile.activeSessions > 1 ? `${profile.activeSessions - 1} ` : ""}
                  sessions. Recommended — this tab stays signed in either way.
                </span>
              }
              onChange={(event) =>
                setPasswords((current) => ({
                  ...current,
                  signOutEverywhere: event.target.checked,
                }))
              }
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-ink-faint">
                API keys keep working — they authenticate independently of your password.
              </p>
              <Button
                variant="primary"
                size="sm"
                loading={savingPassword}
                disabled={
                  (profile.hasPassword && passwords.currentPassword.length === 0) ||
                  passwords.newPassword.length === 0
                }
                onClick={savePassword}
              >
                {profile.hasPassword ? "Update password" : "Set password"}
              </Button>
            </div>
          </CardBody>
        </Card>

        <Card className="border-rose/25">
          <CardHeader
            title="Delete account"
            description="Irreversible from the dashboard. Read what it does before you type anything."
          />
          <CardBody className="space-y-3">
            <ul className="space-y-1.5 text-xs leading-relaxed text-ink-muted">
              <li>· Every active API key is revoked immediately, so live traffic starts failing.</li>
              <li>· All sessions are destroyed, including this one.</li>
              <li>
                · Your email is replaced with a tombstone address and the account is marked{" "}
                <span className="numeric text-ink">deleted</span>, which frees the address for
                re-registration.
              </li>
              <li>
                · Usage rows and audit entries are kept — they are the billing and security record —
                but they no longer point at a usable login.
              </li>
            </ul>
            <div className="flex justify-end">
              <Button variant="danger" size="sm" onClick={() => {
                setDeletePassword("");
                setDeleteConfirmEmail("");
                setDeleteError(null);
                setDeleteOpen(true);
              }}>
                Delete my account
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={confirmDelete}
        title="Delete this account?"
        confirmLabel="Delete account"
        loading={deleting}
        confirmPhrase="DELETE"
        message={
          <div className="space-y-3">
            <p>
              This revokes <span className="numeric text-ink">{profile.activeKeys}</span> active{" "}
              {profile.activeKeys === 1 ? "key" : "keys"} and signs you out everywhere. Confirm with{" "}
              {profile.hasPassword ? "your password." : "your email address."}
            </p>
            <div>
              {profile.hasPassword ? (
                <>
                  <label htmlFor="delete-password" className="block pb-1.5 text-xs text-ink-faint">
                    Password
                  </label>
                  <Input
                    id="delete-password"
                    type="password"
                    value={deletePassword}
                    autoComplete="current-password"
                    onChange={(event) => setDeletePassword(event.target.value)}
                  />
                </>
              ) : (
                <>
                  <label htmlFor="delete-email" className="block pb-1.5 text-xs text-ink-faint">
                    Type <span className="numeric text-ink">{profile.email}</span> to confirm
                  </label>
                  <Input
                    id="delete-email"
                    type="email"
                    value={deleteConfirmEmail}
                    autoComplete="off"
                    placeholder={profile.email}
                    onChange={(event) => setDeleteConfirmEmail(event.target.value)}
                  />
                </>
              )}
              {deleteError ? (
                <p role="alert" className="mt-1.5 text-xs text-rose">
                  {deleteError}
                </p>
              ) : null}
            </div>
          </div>
        }
      />
    </>
  );
}
