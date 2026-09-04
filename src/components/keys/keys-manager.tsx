"use client";

/**
 * API key management.
 *
 * The plaintext secret returned by `POST /api/keys` lives in this component's state for the
 * lifetime of the reveal dialog and is written nowhere else — no localStorage, no URL, no
 * re-fetch path. Closing the dialog discards it permanently, so the copy step is made
 * deliberately hard to skip.
 */
import { useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { Td, TableWrap, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import type { ApiKeyView } from "@/server/services/keys-service";

interface KeysResponse {
  keys: ApiKeyView[];
}

interface CreateResponse extends KeysResponse {
  key: ApiKeyView;
  secret: string;
}

export function KeysManager({
  initialKeys,
  planName,
  maxKeys,
}: {
  initialKeys: ApiKeyView[];
  planName: string;
  maxKeys: number | null;
}) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyView[]>(initialKeys);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ secret: string; name: string } | null>(null);
  const [renaming, setRenaming] = useState<ApiKeyView | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [revoking, setRevoking] = useState<ApiKeyView | null>(null);

  const activeCount = keys.filter((key) => key.status === "active").length;
  const atLimit = maxKeys !== null && activeCount >= maxKeys;

  function failure(error: unknown, fallback: string): string {
    return error instanceof ApiClientError ? error.message : fallback;
  }

  async function submitCreate() {
    const trimmed = name.trim();
    if (trimmed.length < 3) {
      setFormError("Give the key a name of at least 3 characters.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const data = await api.post<CreateResponse>("/api/keys", { name: trimmed });
      setKeys(data.keys);
      setCreateOpen(false);
      setName("");
      setRevealed({ secret: data.secret, name: data.key.name });
    } catch (error) {
      setFormError(failure(error, "Could not create the key."));
    } finally {
      setBusy(false);
    }
  }

  async function submitRename() {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    if (trimmed.length < 3) {
      setFormError("Names must be at least 3 characters.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const data = await api.patch<KeysResponse>(`/api/keys/${renaming.id}`, { name: trimmed });
      setKeys(data.keys);
      setRenaming(null);
      toast.success("Key renamed");
    } catch (error) {
      setFormError(failure(error, "Could not rename the key."));
    } finally {
      setBusy(false);
    }
  }

  async function submitRevoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      const data = await api.delete<KeysResponse>(`/api/keys/${revoking.id}`);
      setKeys(data.keys);
      toast.success("Key revoked", `${revoking.name} can no longer authenticate requests.`);
      setRevoking(null);
    } catch (error) {
      toast.error("Revoke failed", failure(error, "Could not revoke the key."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Your API keys"
          description={
            maxKeys === null
              ? `${activeCount} active · unlimited on ${planName}`
              : `${activeCount} of ${maxKeys} active ${maxKeys === 1 ? "key" : "keys"} on ${planName}`
          }
          action={
            <Button
              variant="primary"
              size="sm"
              disabled={atLimit}
              title={atLimit ? "Revoke a key or upgrade your plan to create another." : undefined}
              onClick={() => {
                setFormError(null);
                setName("");
                setCreateOpen(true);
              }}
            >
              Create key
            </Button>
          }
        />

        {keys.length === 0 ? (
          <EmptyState
            title="No API keys yet"
            description="A key authenticates your requests to the gateway. One key works across every model your plan allows."
            action={
              <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                Create your first key
              </Button>
            }
          />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Key</Th>
                <Th>Status</Th>
                <Th align="right">Requests</Th>
                <Th align="right">Tokens</Th>
                <Th>Created</Th>
                <Th>Last used</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <Tr key={key.id}>
                  <Td className="font-medium text-ink">{key.name}</Td>
                  <Td className="numeric whitespace-nowrap">{key.masked}</Td>
                  <Td>
                    {key.status === "active" ? (
                      <StatusBadge status="active" />
                    ) : (
                      <Badge tone="neutral" dot>
                        revoked
                      </Badge>
                    )}
                  </Td>
                  <Td align="right" className="numeric">
                    {formatNumber(key.requestCount)}
                  </Td>
                  <Td align="right" className="numeric">
                    {formatNumber(key.totalTokens)}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDateTime(key.createdAt)}</Td>
                  <Td className="whitespace-nowrap">
                    {key.lastUsedAt ? formatRelative(key.lastUsedAt) : "Never"}
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        label={`Rename ${key.name}`}
                        onClick={() => {
                          setFormError(null);
                          setRenameValue(key.name);
                          setRenaming(key);
                        }}
                      >
                        <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                          <path
                            d="M10.5 2.5l3 3-7 7H3.5v-3l7-7z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </IconButton>
                      {key.status === "active" ? (
                        <IconButton
                          label={`Revoke ${key.name}`}
                          className="text-rose hover:bg-rose/12"
                          onClick={() => setRevoking(key)}
                        >
                          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                            <path
                              d="M3 5.5h10M6 5.5V4h4v1.5M4.5 5.5l.5 7.5h6l.5-7.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </IconButton>
                      ) : null}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create an API key"
        description="Name it after where it will be used — the name is the only way to tell keys apart later."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitCreate} loading={busy}>
              Create key
            </Button>
          </>
        }
      >
        <Field
          label="Key name"
          htmlFor="key-name"
          error={formError}
          help="For example: production-api, staging-worker, local-dev."
        >
          <Input
            id="key-name"
            value={name}
            autoComplete="off"
            maxLength={60}
            placeholder="production-api"
            aria-invalid={formError ? true : undefined}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitCreate();
            }}
          />
        </Field>
      </Modal>

      <Modal
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        closeOnBackdrop={false}
        title="Copy your key now"
        description="This is the only time the full key is shown. We store a hash of it, so it cannot be displayed again."
        footer={
          <Button variant="primary" onClick={() => setRevealed(null)}>
            I have saved it
          </Button>
        }
      >
        {revealed ? (
          <div className="space-y-3">
            <p className="text-xs text-ink-muted">
              Key <span className="font-medium text-ink">{revealed.name}</span>
            </p>
            <div className="flex items-start gap-2 rounded-xl border border-line bg-canvas p-3">
              <code className="min-w-0 flex-1 font-mono text-[12.5px] leading-relaxed break-all text-brand">
                {revealed.secret}
              </code>
              <CopyButton value={revealed.secret} toastMessage="API key copied" />
            </div>
            <p className="rounded-lg border border-amber/30 bg-amber/8 px-3 py-2 text-xs leading-relaxed text-amber">
              Treat it like a password. Anyone holding it can spend your token allocation. If it
              leaks, revoke it here and create a replacement.
            </p>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename key"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitRename} loading={busy}>
              Save
            </Button>
          </>
        }
      >
        <Field label="Key name" htmlFor="rename-key" error={formError}>
          <Input
            id="rename-key"
            value={renameValue}
            autoComplete="off"
            maxLength={60}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitRename();
            }}
          />
        </Field>
      </Modal>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={submitRevoke}
        loading={busy}
        title="Revoke this key?"
        confirmLabel="Revoke key"
        confirmPhrase={revoking?.name}
        message={
          <>
            Requests signed with <span className="font-medium text-ink">{revoking?.name}</span> will
            start failing with <span className="numeric">401 invalid_api_key</span> immediately. This
            cannot be undone — usage already recorded against the key is kept for your logs.
          </>
        }
      />
    </>
  );
}
