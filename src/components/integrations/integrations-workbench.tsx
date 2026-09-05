"use client";

/**
 * Integrations workbench.
 *
 * Snippets are generated in the browser from the base URL, the chosen model and — optionally —
 * a key the user pastes in themselves. We cannot fill the key in automatically: only its hash
 * is stored, so there is no endpoint that could return it. The paste field stays in component
 * state and is never sent to the server, which is stated in the UI rather than assumed.
 */
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CodeTabs, type CodeTab } from "@/components/ui/code-block";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/client/api";
import { formatDateTime, titleCase } from "@/lib/format";
import {
  PLACEHOLDER_KEY,
  anthropicSnippet,
  envSnippet,
  langchainSnippet,
  listModelsSnippet,
  quickstartSnippets,
  streamingSnippets,
  type SnippetContext,
} from "@/lib/snippets";
import type { IntegrationView } from "@/server/services/integrations-service";

export interface KeyOption {
  id: string;
  name: string;
  last4: string;
  status: string;
}

const TYPES = [
  { id: "openai_sdk", label: "OpenAI SDK" },
  { id: "anthropic_sdk", label: "Anthropic SDK" },
  { id: "rest", label: "REST / fetch" },
  { id: "langchain", label: "LangChain" },
  { id: "webhook", label: "Webhook" },
  { id: "custom", label: "Custom" },
] as const;

interface IntegrationsResponse {
  integrations: IntegrationView[];
}

export function IntegrationsWorkbench({
  baseUrl,
  models,
  keys,
  initialIntegrations,
}: {
  baseUrl: string;
  models: string[];
  keys: KeyOption[];
  initialIntegrations: IntegrationView[];
}) {
  const toast = useToast();
  const [model, setModel] = useState(models[0] ?? "relayn-mock-chat");
  const [pastedKey, setPastedKey] = useState("");
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ type: "openai_sdk", name: "", apiKeyId: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<IntegrationView | null>(null);

  const context: SnippetContext = useMemo(
    () => ({ baseUrl, model, apiKey: pastedKey.trim() || PLACEHOLDER_KEY }),
    [baseUrl, model, pastedKey],
  );

  const quickstart: CodeTab[] = quickstartSnippets(context);
  const streaming: CodeTab[] = streamingSnippets(context);
  const extras: CodeTab[] = [
    {
      id: "anthropic",
      label: "Anthropic dialect",
      language: "python",
      filename: "anthropic_example.py",
      code: anthropicSnippet(context),
    },
    {
      id: "langchain",
      label: "LangChain",
      language: "python",
      filename: "langchain_example.py",
      code: langchainSnippet(context),
    },
    {
      id: "models",
      label: "List models",
      language: "bash",
      filename: "models.sh",
      code: listModelsSnippet(context),
    },
    {
      id: "env",
      label: "Environment",
      language: "ini",
      filename: ".env",
      code: envSnippet(context),
    },
  ];

  async function submitCreate() {
    const name = form.name.trim();
    if (name.length < 2) {
      setFormError("Give the integration a name.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const data = await api.post<IntegrationsResponse>("/api/integrations", {
        type: form.type,
        name,
        apiKeyId: form.apiKeyId || null,
        configuration: { baseUrl, model },
      });
      setIntegrations(data.integrations);
      setCreateOpen(false);
      setForm({ type: "openai_sdk", name: "", apiKeyId: "" });
      toast.success("Integration saved");
    } catch (error) {
      setFormError(
        error instanceof ApiClientError ? error.message : "Could not save the integration.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      const data = await api.delete<IntegrationsResponse>(`/api/integrations/${deleting.id}`);
      setIntegrations(data.integrations);
      toast.success("Integration removed");
      setDeleting(null);
    } catch (error) {
      toast.error(
        "Remove failed",
        error instanceof ApiClientError ? error.message : "Could not remove the integration.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Snippet builder"
          description="Pick a model, optionally paste a key, and every example below updates to match."
        />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label="Model" htmlFor="snippet-model" help="Only models this account can call.">
            <Select
              id="snippet-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.length === 0 ? <option value="">No models available</option> : null}
              {models.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Your API key (optional)"
            htmlFor="snippet-key"
            help="Stays in this browser tab — it is never sent to our servers or saved. Leave blank to keep the placeholder."
          >
            <Input
              id="snippet-key"
              value={pastedKey}
              autoComplete="off"
              spellCheck={false}
              placeholder={PLACEHOLDER_KEY}
              onChange={(event) => setPastedKey(event.target.value)}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Quickstart"
          description="The gateway speaks the OpenAI chat completions protocol, so official SDKs work by changing only the base URL."
          action={<Badge tone="brand">OpenAI compatible</Badge>}
        />
        <CardBody>
          <CodeTabs tabs={quickstart} />
        </CardBody>
      </Card>

      {/* `grid-cols-1` is load-bearing. Below `xl` this grid has a single implicit track, which is
          sized `auto` and so takes its minimum from its content — and each card holds a `CodeTabs`
          whose `<pre>` only scrolls once something upstream has clamped its width. Without the
          clamp the track grew to the longest snippet line (~706px), both cards grew with it, and
          the page scrolled sideways on a phone. `grid-cols-1` compiles to the missing
          `repeat(1, minmax(0, 1fr))`. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Streaming"
            description="Set stream: true to receive server-sent events. Usage is recorded when the stream finishes."
          />
          <CardBody>
            <CodeTabs tabs={streaming} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Other clients"
            description="Anthropic-dialect requests, LangChain, model discovery and environment variables."
          />
          <CardBody>
            <CodeTabs tabs={extras} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Saved integrations"
          description="A record of where you wired the gateway in. Only the key reference is stored — never a secret."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setFormError(null);
                setCreateOpen(true);
              }}
            >
              Add integration
            </Button>
          }
        />
        {integrations.length === 0 ? (
          <EmptyState
            compact
            title="Nothing saved yet"
            description="Optional bookkeeping: note which app uses which key so you know what breaks if you revoke one."
          />
        ) : (
          <ul className="divide-y divide-line">
            {integrations.map((integration) => (
              <li key={integration.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{integration.name}</p>
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    {titleCase(integration.type)} · {integration.apiKeyLabel ?? "no key attached"} ·
                    added {formatDateTime(integration.createdAt)}
                  </p>
                </div>
                <IconButton
                  label={`Remove ${integration.name}`}
                  className="text-rose hover:bg-rose/12"
                  onClick={() => setDeleting(integration)}
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
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Save an integration"
        description="Bookkeeping only — this does not change how your keys work."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitCreate} loading={busy}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" htmlFor="integration-name" error={formError}>
            <Input
              id="integration-name"
              value={form.name}
              maxLength={80}
              placeholder="Support bot (production)"
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </Field>
          <Field label="Client" htmlFor="integration-type">
            <Select
              id="integration-type"
              value={form.type}
              onChange={(event) => setForm((current) => ({ ...current, type: event.target.value }))}
            >
              {TYPES.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="API key"
            htmlFor="integration-key"
            help="Which of your keys this integration uses. Optional."
          >
            <Select
              id="integration-key"
              value={form.apiKeyId}
              onChange={(event) =>
                setForm((current) => ({ ...current, apiKeyId: event.target.value }))
              }
            >
              <option value="">No key attached</option>
              {keys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.name} ····{key.last4}
                  {key.status === "revoked" ? " (revoked)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={submitDelete}
        loading={busy}
        title="Remove this integration?"
        confirmLabel="Remove"
        message={
          <>
            This only deletes the note about{" "}
            <span className="font-medium text-ink">{deleting?.name}</span>. Your API key keeps
            working — revoke the key itself on the API keys page if that is what you meant.
          </>
        }
      />
    </>
  );
}
