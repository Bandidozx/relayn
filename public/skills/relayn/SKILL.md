---
name: relayn
description: Call the Relayn AI gateway — one OpenAI- and Anthropic-compatible endpoint in front of many upstream providers, with per-key quotas, plan-gated models and automatic provider fallback. Use when a task needs an LLM and a Relayn key is available.
---

# Relayn

Relayn is an API gateway. One base URL, one key, many upstream providers. It speaks two
dialects on the same deployment:

- `POST /v1/chat/completions` — OpenAI Chat Completions
- `POST /v1/messages` — Anthropic Messages

Point an existing OpenAI or Anthropic SDK at the base URL and it works unchanged. No
Relayn-specific client is needed, and none exists.

## Setup

Two environment variables. Nothing else is required.

```bash
RELAYN_URL=https://bandidoz.biz.id   # deployment base URL, no trailing slash, no /v1
RELAYN_KEY=rly_live_...              # created in the dashboard under API Keys
```

`RELAYN_URL` is the operator's deployment; ask them for it rather than assuming the value
above. Keys always start with `rly_live_` and are shown exactly once at creation — Relayn
stores only a SHA-256 hash, so a lost key must be replaced, not recovered.

Send the key either way; both work on every endpoint:

```
Authorization: Bearer $RELAYN_KEY
x-api-key: $RELAYN_KEY
```

## Step 1 — is it up?

```bash
curl -s -o /dev/null -w '%{http_code}' "$RELAYN_URL/api/health"
```

`GET /api/health` is unauthenticated and answers `{"ok":true}` with **200** when the
deployment can serve traffic, `{"ok":false}` with **503** when it cannot. Branch on the
status code alone. The body carries nothing else on purpose — no versions, provider names or
model counts — so do not try to learn the catalogue from it.

## Step 2 — what can I call?

```bash
curl -s "$RELAYN_URL/v1/models" -H "Authorization: Bearer $RELAYN_KEY"
```

Authenticated, and filtered to the plan attached to *this* key — a Free key does not see a
Business-tier model at all. Never hardcode a model id: list first, then use an `id` from the
response verbatim.

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o-mini",
      "object": "model",
      "created": 1756944000,
      "owned_by": "openai",
      "relayn": {
        "name": "GPT-4o mini",
        "category": "chat",
        "description": "…",
        "context_window": 128000,
        "max_output_tokens": 16384,
        "input_price_per_1m_usd": 0.15,
        "output_price_per_1m_usd": 0.6,
        "capabilities": ["vision", "tools"],
        "min_plan": "free"
      }
    }
  ]
}
```

`owned_by` is the **Relayn provider id that routes the model**, not the company that trained
it — an id served through a reseller upstream reads as that reseller. The `relayn` block is an
extension; SDKs that only expect `{id, object, created, owned_by}` ignore it safely.

There is one flat list. There are no per-modality listing endpoints — filter on
`relayn.category` client-side if you need to.

## Step 3 — call it

### OpenAI dialect

```bash
curl -s "$RELAYN_URL/v1/chat/completions" \
  -H "Authorization: Bearer $RELAYN_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'
```

Accepted fields: `model`, `messages`, `temperature` (0–2), `top_p` (0–1), `max_tokens`
(1–200000), `stop` (string or ≤4 strings), `stream`, `stream_options.include_usage`, `tools`
(≤128), `tool_choice`, `user`, and `n` — which must be `1` if sent at all. `messages` takes
1–200 entries with roles `system`, `user`, `assistant`, `tool`, `developer`; `content` is a
string, `null`, or an array of `{type, text?, image_url?}` parts. Anything else is rejected
with a 400 that names the offending path, e.g. `messages: Too big: expected array to have
<=200 items`. Unknown fields are dropped, not forwarded.

With an OpenAI SDK:

```python
from openai import OpenAI
client = OpenAI(base_url=f"{RELAYN_URL}/v1", api_key=RELAYN_KEY)
client.chat.completions.create(model="gpt-4o-mini",
                               messages=[{"role": "user", "content": "ping"}])
```

### Anthropic dialect

```bash
curl -s "$RELAYN_URL/v1/messages" \
  -H "x-api-key: $RELAYN_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4","max_tokens":256,
       "messages":[{"role":"user","content":"ping"}]}'
```

`max_tokens` is **required** here. `temperature` is capped at 1 (not 2), `system` is a
top-level string or content-part array, `stop_sequences` replaces `stop`, and roles are
`user`/`assistant` only. `anthropic-version` is accepted and ignored — send it if your SDK
insists, omit it otherwise.

The same model ids work in both dialects: a model's `id` is a Relayn catalogue entry, and
Relayn translates the wire format for whichever upstream serves it. An "Anthropic" id can be
called through `/v1/chat/completions` and vice versa.

## Streaming

Send `"stream": true`. Both dialects return `text/event-stream` in their own native framing:

- `/v1/chat/completions` — `data: {chunk}` frames, terminated by `data: [DONE]`. Ask for
  totals with `"stream_options": {"include_usage": true}`.
- `/v1/messages` — named events: `message_start`, `content_block_start`,
  `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

An upstream that fails *before the first token* produces a normal HTTP error status, not a
200 containing an error frame — so the usual SDK error handling still fires. A failure
*after* the first token cannot change the status code: `/v1/messages` emits an `error` event
and `/v1/chat/completions` closes the stream. Treat a stream that ends without `[DONE]` /
`message_stop` as truncated.

## Response headers

Present on every successful call:

| Header | Meaning |
| --- | --- |
| `x-request-id` | Correlates with the operator's usage log. Quote it in a bug report. |
| `x-relayn-model` | The model that **actually served** the request. |
| `x-relayn-provider` | Upstream provider that served it. |

Non-streaming responses add `x-relayn-latency-ms` and `x-relayn-cost-micro-usd` (millionths of
a dollar, integer). `/v1/chat/completions` also sets `x-relayn-usage-estimated: true` — present
only when true — when the upstream returned no token counts and Relayn had to approximate them.

When a fallback happened you also get:

| Header | Meaning |
| --- | --- |
| `x-relayn-requested-model` | Present only when a different model answered than you asked for. |
| `x-relayn-fallback-attempts` | How many upstreams failed first. |

**Read `x-relayn-model`, not the `model` field, when the identity of the answering model
matters.** A catalogue entry may declare a fallback chain, and Relayn advances through it on a
retryable upstream failure (429, 5xx, timeout, out-of-credit, unknown-id, missing credential).
A malformed request or a rejected operator credential stops the chain instead — retrying those
on another provider would fail identically.

From a browser these `x-relayn-*` headers are not readable cross-origin: the deployment sets
`Access-Control-Allow-Origin: *` for `/v1/*` but no `Access-Control-Expose-Headers`. That is
mostly moot — an API key does not belong in a browser.

## Errors

Native envelope per dialect, so SDK error handling keeps working:

```json
{ "error": { "message": "…", "type": "rate_limit_error", "code": "rate_limit_exceeded", "param": null } }
```

```json
{ "type": "error", "error": { "type": "rate_limit_error", "message": "…" } }
```

Branch on `code` (stable), not on `message` (human-readable, may be reworded).

| Status | `code` | What to do |
| --- | --- | --- |
| 400 | `invalid_json` | Body was not JSON. |
| 400 | `invalid_body` | The message names the failing field path. Fix the request; do not retry. |
| 400 | `model_required` | `model` was missing or empty. |
| 401 | `missing_api_key` | Send `Authorization: Bearer <key>`. |
| 401 | `invalid_api_key` | Wrong key. |
| 401 | `api_key_revoked` | The key was revoked in the dashboard. Get a new one. |
| 402 | `subscription_inactive` | The account's subscription is not active. |
| 402 | `insufficient_tokens` | Monthly allocation exhausted; the message states the reset date. |
| 403 | `account_suspended` | Operator action. Contact them. |
| 403 | `model_not_available_on_plan` | The model needs a higher plan than this key has. |
| 404 | `model_not_found` | Not in the catalogue. Re-read `GET /v1/models`. |
| 429 | `rate_limit_exceeded` | Honour `retry-after` (seconds), then retry. |
| 499 | `client_closed_request` | You aborted. Nothing was billed. |
| 500 | `internal_error` | Relayn's fault. Retry once, then report `x-request-id`. |
| 503 | `model_disabled` | The operator turned this model off. Pick another. |
| 503 | `provider_unconfigured` / `provider_not_registered` | The route has no working upstream. |

`upstream_error`, `upstream_timeout`, `upstream_rate_limited`, `upstream_out_of_credit` and
`model_unavailable` reach you only when **every** link in the model's fallback chain failed, so
an immediate retry of the same id is usually pointless — try a different model.

429s carry `retry-after`, `x-ratelimit-limit`, `x-ratelimit-remaining: 0` and
`x-ratelimit-reset` (epoch ms). The limit is a fixed window per key *and* per account, sized by
plan: Free 20/min, Pro 60, Business 300, Enterprise and Unlimited 1200. Token allocation is
separate and monthly — 250K on Free up to uncapped on Unlimited.

## Rules

- **List before you call.** Model ids are operator-configured, change without notice, and are
  plan-filtered per key. A hardcoded id is a 404 waiting to happen.
- **Never log or echo the key.** It is a bearer credential with a billed quota behind it.
- **One request, one model.** `n` must be 1; there is no batch endpoint.
- **Do not retry a 4xx** other than 429. The request itself is what is wrong.
- **Attribute honestly.** If `x-relayn-model` differs from what you asked for, a fallback
  served the request — say so rather than reporting the requested id.
