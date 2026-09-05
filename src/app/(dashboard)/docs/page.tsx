import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock, CodeTabs, type CodeTab } from "@/components/ui/code-block";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { requireUser } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { PLANS, PUBLIC_PLAN_ORDER, planOf, type PlanId } from "@/lib/plans";
import { formatCompact, formatNumber } from "@/lib/format";
import {
  PLACEHOLDER_KEY,
  quickstartSnippets,
  streamingSnippets,
  listModelsSnippet,
  anthropicSnippet,
  type SnippetContext,
} from "@/lib/snippets";
import { listModelsForUser } from "@/server/services/models-service";
import { getRequestSubscription } from "@/lib/usage/accounting";

export const metadata: Metadata = { title: "API reference" };

const SECTIONS = [
  { id: "base-url", label: "Base URL & auth" },
  { id: "quickstart", label: "Quickstart" },
  { id: "endpoints", label: "Endpoints" },
  { id: "chat-completions", label: "Chat completions" },
  { id: "streaming", label: "Streaming" },
  { id: "models", label: "Listing models" },
  { id: "messages", label: "Anthropic dialect" },
  { id: "errors", label: "Error codes" },
  { id: "rate-limits", label: "Rate limits" },
  { id: "usage", label: "Usage tracking" },
] as const;

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-24">
      <CardHeader title={title} {...(description ? { description } : {})} />
      <CardBody className="space-y-3.5">{children}</CardBody>
    </Card>
  );
}

function Prose({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-ink-muted">{children}</p>;
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="numeric text-ink">{children}</span>;
}

interface ErrorRow {
  status: number;
  type: string;
  code: string;
  meaning: string;
}

/** Mirrors every `GatewayError` thrown in `src/lib/gateway/pipeline.ts`. */
const ERRORS: ErrorRow[] = [
  { status: 400, type: "invalid_request_error", code: "model_required", meaning: "`model` was missing or not a string." },
  { status: 400, type: "invalid_request_error", code: "invalid_body", meaning: "The JSON body failed schema validation. `error.message` names the field." },
  { status: 401, type: "authentication_error", code: "missing_api_key", meaning: "No `Authorization: Bearer` header was sent." },
  { status: 401, type: "authentication_error", code: "invalid_api_key", meaning: "The key does not match any stored hash." },
  { status: 401, type: "authentication_error", code: "api_key_revoked", meaning: "The key exists but was revoked. Create a new one." },
  { status: 402, type: "insufficient_quota", code: "subscription_inactive", meaning: "The subscription is not active — check the Subscription page." },
  { status: 402, type: "insufficient_quota", code: "insufficient_tokens", meaning: "The monthly allocation is spent. The message states the reset date." },
  { status: 403, type: "permission_error", code: "account_suspended", meaning: "An operator suspended the account." },
  { status: 403, type: "permission_error", code: "model_not_available_on_plan", meaning: "The model is gated above this account. Unlimited clears every gate." },
  { status: 404, type: "not_found_error", code: "model_not_found", meaning: "No such model id. `GET /v1/models` lists yours." },
  { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded", meaning: "Per-key request rate exceeded. Honour `retry-after`." },
  { status: 503, type: "service_unavailable", code: "model_disabled", meaning: "The operator disabled this model." },
  { status: 503, type: "service_unavailable", code: "provider_not_registered", meaning: "No adapter is registered for the model's provider." },
  { status: 503, type: "service_unavailable", code: "provider_unconfigured", meaning: "The provider's credential env var is not set on this deployment." },
];

const PARAMS: [string, string, string][] = [
  ["model", "string · required", "A model id from GET /v1/models."],
  ["messages", "array · required", "1–200 messages with role system | user | assistant | tool | developer."],
  ["stream", "boolean", "Server-sent events instead of one JSON body."],
  ["stream_options", "object", "`{ include_usage: true }` appends a final chunk carrying token counts."],
  ["max_tokens", "integer 1–200000", "Upper bound on the completion."],
  ["temperature", "number 0–2", "Sampling temperature."],
  ["top_p", "number 0–1", "Nucleus sampling."],
  ["stop", "string | string[≤4]", "Stop sequences."],
  ["tools / tool_choice", "array / object", "Passed through to providers that support tool calling."],
  ["user", "string", "Your own end-user identifier; stored on the usage row."],
  ["n", "literal 1", "Multiple choices are rejected rather than silently ignored."],
];

export default async function DocsPage() {
  const { user } = await requireUser();
  const [catalogue, subscription] = await Promise.all([
    listModelsForUser(user.id),
    getRequestSubscription(user.id),
  ]);
  const plan = planOf(subscription.plan);

  // Examples use a model this account can actually call, so copy-paste works first try.
  const sample =
    catalogue.models.find((model) => model.available && model.category === "chat") ??
    catalogue.models.find((model) => model.available);

  const context: SnippetContext = {
    // Origin only — the snippet helpers append `/v1` themselves.
    baseUrl: env.appUrl,
    apiKey: PLACEHOLDER_KEY,
    model: sample?.modelId ?? "relayn/no-model-seeded",
  };

  const quickstart: CodeTab[] = quickstartSnippets(context);
  const streaming: CodeTab[] = streamingSnippets(context);

  /*
   * Rows for the rate-limit table: the two plans a reader can actually end up on, plus their own
   * row when an operator assigned something else by hand. Listing all five would document
   * Pro/Business/Enterprise as if they were on sale, and nothing sells them.
   */
  const limitRows = [...new Set<PlanId>([...PUBLIC_PLAN_ORDER, plan.id])]
    .map((id) => PLANS[id])
    .sort((a, b) => a.order - b.order);

  return (
    <>
      <PageHeader
        title="API reference"
        description="Everything the gateway accepts and returns. Written against the code in this deployment, not a generic template."
        action={<Badge tone="neutral">v1</Badge>}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_15rem] xl:items-start">
        <div className="min-w-0 space-y-4">
          <Section
            id="base-url"
            title="Base URL & authentication"
            description="One base URL, one header. Any OpenAI-compatible client works unchanged."
          >
            <CodeBlock
              language="http"
              code={`${env.appUrl}/v1\n\nAuthorization: Bearer rly_live_…\nContent-Type: application/json`}
            />
            <Prose>
              Keys are generated with a CSPRNG and only their SHA-256 hash is stored, so a key is
              shown exactly once — at creation. There is no endpoint that can return it again. Send
              it from your server, never from a browser: anything in front-end code is public.
            </Prose>
            <Prose>
              Requests are also accepted with <Mono>x-api-key</Mono> for clients that use the
              Anthropic convention. Every response carries an <Mono>x-request-id</Mono> which is the
              same id shown on <Link href="/usage" className="text-brand hover:opacity-80">Usage logs</Link>
              , so a failing call can be traced end to end.
            </Prose>
          </Section>

          <Section
            id="quickstart"
            title="Quickstart"
            description={
              sample
                ? `Runnable as-is against ${sample.modelId} — a model this account can call.`
                : "Seed the catalogue with npm run db:seed to get a callable model id here."
            }
          >
            <CodeTabs tabs={quickstart} />
            <Prose>
              Replace <Mono>{PLACEHOLDER_KEY}</Mono> with a key from{" "}
              <Link href="/api-keys" className="text-brand hover:opacity-80">
                API keys
              </Link>
              . Store it in an environment variable rather than the source file.
            </Prose>
          </Section>

          <Section
            id="endpoints"
            title="Endpoints"
            description="Three gateway endpoints. Everything else on this domain is the dashboard's own API and uses cookie auth, not keys."
          >
            <TableWrap>
              <thead>
                <tr>
                  <Th>Method</Th>
                  <Th>Path</Th>
                  <Th>Purpose</Th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["POST", "/v1/chat/completions", "OpenAI-compatible chat, streaming or buffered."],
                  ["GET", "/v1/models", "Models your key may call, filtered by plan."],
                  ["POST", "/v1/messages", "Anthropic-dialect messages, same accounting."],
                ].map(([method, path, purpose]) => (
                  <Tr key={path}>
                    <Td>
                      <Badge tone={method === "GET" ? "sky" : "brand"}>{method}</Badge>
                    </Td>
                    <Td className="numeric text-ink">{path}</Td>
                    <Td>{purpose}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
            <Prose>
              <Mono>OPTIONS</Mono> is answered with <Mono>204</Mono> on each of them for browser
              preflight. Unknown paths under <Mono>/v1</Mono> return the standard 404 envelope.
            </Prose>
          </Section>

          <Section
            id="chat-completions"
            title="POST /v1/chat/completions"
            description="The main endpoint. Body and response match the OpenAI schema, so existing SDKs need only a base URL change."
          >
            <TableWrap>
              <thead>
                <tr>
                  <Th>Field</Th>
                  <Th>Type</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {PARAMS.map(([field, type, notes]) => (
                  <Tr key={field}>
                    <Td className="numeric text-ink">{field}</Td>
                    <Td className="whitespace-nowrap text-[11px]">{type}</Td>
                    <Td>{notes}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
            <CodeBlock
              filename="200 OK"
              language="json"
              code={`{
  "id": "chatcmpl_…",
  "object": "chat.completion",
  "created": 1750000000,
  "model": "${context.model}",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "…" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 24, "completion_tokens": 118, "total_tokens": 142 }
}`}
            />
            <Prose>
              The body is validated before any provider is contacted, so out-of-range values (a
              temperature of 5, <Mono>n: 2</Mono>, 300 messages) come back as a <Mono>400</Mono>
              naming the field instead of an opaque upstream error. Fields not listed above are
              dropped rather than forwarded. Prompt and completion text is never written to the
              database — only the token counts above.
            </Prose>
          </Section>

          <Section
            id="streaming"
            title="Streaming"
            description="Set stream: true for server-sent events in the OpenAI delta format."
          >
            <CodeTabs tabs={streaming} />
            <CodeBlock
              filename="text/event-stream"
              language="text"
              code={`data: {"id":"chatcmpl_…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}

data: {"id":"chatcmpl_…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"}}]}

data: {"id":"chatcmpl_…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]`}
            />
            <Prose>
              Usage is recorded when the stream closes, whether it finished or broke mid-flight — a
              client that disconnects still gets billed for the tokens the provider generated. Add{" "}
              <Mono>{`"stream_options": { "include_usage": true }`}</Mono> to receive token counts in
              a final chunk. Streamed rows are flagged in the usage log, and when a provider omits
              counts the estimate is marked with <Mono>x-relayn-usage-estimated</Mono>.
            </Prose>
          </Section>

          <Section
            id="models"
            title="GET /v1/models"
            description="Plan-filtered catalogue. A key never sees a model it cannot call."
          >
            <CodeBlock language="bash" code={listModelsSnippet(context)} />
            <Prose>
              The response is the OpenAI <Mono>{`{ id, object, created, owned_by }`}</Mono> shape plus
              a namespaced <Mono>relayn</Mono> object carrying context window, max output tokens,
              per-million pricing, capabilities and the minimum plan. Namespacing keeps strict SDK
              parsers happy. Your account currently sees{" "}
              <Mono>{catalogue.models.filter((model) => model.available).length}</Mono> of{" "}
              <Mono>{catalogue.models.length}</Mono> catalogue entries.
            </Prose>
          </Section>

          <Section
            id="messages"
            title="POST /v1/messages"
            description="Anthropic dialect for clients built against that SDK — same keys, same accounting, same usage rows."
          >
            <CodeBlock language="python" code={anthropicSnippet(context)} />
            <Prose>
              <Mono>max_tokens</Mono> is required here, <Mono>system</Mono> is a top-level field
              rather than a message, and errors come back as{" "}
              <Mono>{`{ "type": "error", "error": { "type", "message" } }`}</Mono>. Both dialects route
              to the same provider adapters, so the model id namespace is shared.
            </Prose>
          </Section>

          <Section
            id="errors"
            title="Error codes"
            description="Every failure is an OpenAI-shaped envelope with a stable machine code you can switch on."
          >
            <CodeBlock
              language="json"
              code={`{
  "error": {
    "message": "\`${context.model}\` is not available to this account. The one-time Unlimited purchase unlocks the full catalogue.",
    "type": "permission_error",
    "code": "model_not_available_on_plan"
  }
}`}
            />
            <TableWrap>
              <thead>
                <tr>
                  <Th>Status</Th>
                  <Th>Type</Th>
                  <Th>Code</Th>
                  <Th>Meaning</Th>
                </tr>
              </thead>
              <tbody>
                {ERRORS.map((row) => (
                  <Tr key={row.code}>
                    <Td className="numeric text-ink">{row.status}</Td>
                    <Td className="whitespace-nowrap text-[11px]">{row.type}</Td>
                    <Td className="numeric whitespace-nowrap text-[11px] text-ink">{row.code}</Td>
                    <Td>{row.meaning}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
            <Prose>
              Failed calls are still written to the usage log with their status code and error code,
              which is why the error rate on the overview can move without any successful traffic.
              Internal faults are logged server-side and returned as a bare{" "}
              <Mono>500 internal_error</Mono> — stack traces and provider payloads are never echoed
              back.
            </Prose>
          </Section>

          <Section
            id="rate-limits"
            title="Rate limits"
            description="Fixed one-minute windows, applied per key, per user and per IP."
          >
            <TableWrap>
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th align="right">Requests / min</Th>
                  <Th align="right">Tokens / month</Th>
                  <Th align="right">Active keys</Th>
                </tr>
              </thead>
              <tbody>
                {limitRows.map((entry) => (
                  <Tr key={entry.id} className={entry.id === plan.id ? "bg-brand/6" : undefined}>
                    <Td className="text-ink">
                      {entry.name}
                      {entry.id === plan.id ? (
                        <Badge tone="brand" className="ml-2">
                          yours
                        </Badge>
                      ) : null}
                    </Td>
                    <Td align="right" className="numeric">
                      {formatNumber(entry.requestsPerMinute)}
                    </Td>
                    <Td align="right" className="numeric">
                      {/* The unlimited plan's allocation column is a sentinel, not a budget —
                          printing "2B" here would read as a real monthly ceiling. */}
                      {entry.unlimited ? "no ceiling" : formatCompact(entry.tokenAllocation)}
                    </Td>
                    <Td align="right" className="numeric">
                      {entry.maxApiKeys === null ? "unlimited" : formatNumber(entry.maxApiKeys)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
            <Prose>
              A 429 carries <Mono>retry-after</Mono>, <Mono>x-ratelimit-limit</Mono>,{" "}
              <Mono>x-ratelimit-remaining</Mono> and <Mono>x-ratelimit-reset</Mono>. Back off for the
              stated interval rather than retrying immediately — retries inside the window count
              against the same bucket. Counters live in process memory, which is correct for a
              single instance; multi-instance deployments implement the{" "}
              <Mono>RateLimitStore</Mono> interface against Redis <Mono>INCR</Mono>/
              <Mono>EXPIRE</Mono> and pass it to <Mono>rateLimit()</Mono>.
            </Prose>
          </Section>

          <Section
            id="usage"
            title="Usage tracking & token accounting"
            description="What gets recorded per request, and how the dashboard's numbers are derived from it."
          >
            <TableWrap>
              <thead>
                <tr>
                  <Th>Response header</Th>
                  <Th>Meaning</Th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["x-request-id", "Primary key for the usage row. Quote it in support tickets."],
                  ["x-relayn-model", "Canonical model id the request was routed to."],
                  ["x-relayn-provider", "Adapter that served it."],
                  ["x-relayn-latency-ms", "Server-measured round trip, buffered responses only."],
                  ["x-relayn-cost-micro-usd", "Catalogue price of this call in millionths of a dollar."],
                  ["x-relayn-usage-estimated", "Present when the provider returned no token counts."],
                ].map(([header, meaning]) => (
                  <Tr key={header}>
                    <Td className="numeric whitespace-nowrap text-ink">{header}</Td>
                    <Td>{meaning}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
            <Prose>
              Each call writes one usage row — timestamp, key, model, provider, endpoint, prompt and
              completion tokens, latency, HTTP status, error code, streamed flag, cost and client IP
              — and increments the subscription&apos;s consumed-token counter in the same
              transaction. Message content is not part of that row, by design.
            </Prose>
            <Prose>
              Allocation is enforced before the provider call: once consumed tokens reach the plan
              allocation, requests fail with <Mono>402 insufficient_tokens</Mono> until the cycle
              renews. Every figure on the overview is a query over these rows, so a fresh account
              shows empty states rather than sample numbers.
            </Prose>
            <Prose>
              Costs are stored as integer micro-USD to avoid floating-point drift, priced from the
              catalogue&apos;s per-million input and output rates at the time of the call. It is what
              the traffic would cost — no payment processor is connected in this deployment.
            </Prose>
          </Section>
        </div>

        <nav
          aria-label="On this page"
          className="panel sticky top-4 order-first hidden p-3 xl:order-none xl:block"
        >
          <p className="px-2 pb-1.5 text-[10px] font-medium tracking-wider text-ink-faint uppercase">
            On this page
          </p>
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="block rounded-lg px-2 py-1.5 text-xs text-ink-muted transition-colors hover:bg-hover hover:text-ink"
            >
              {section.label}
            </a>
          ))}
          <p className="mt-2 border-t border-line px-2 pt-2.5 text-[11px] leading-relaxed text-ink-faint">
            You are on <span className="text-ink">{plan.name}</span> —{" "}
            {formatNumber(plan.requestsPerMinute)} req/min,{" "}
            {formatCompact(plan.tokenAllocation)} tokens/month.
          </p>
        </nav>
      </div>
    </>
  );
}


