# Relayn

One API key for every frontier model. Relayn is an OpenAI-compatible AI gateway with a
usage dashboard: sign up, mint a key, point any OpenAI or Anthropic SDK at it, and every
request is authenticated, quota-checked, routed to an upstream provider, metered and
logged. The dashboard renders those rows — nothing on it is hardcoded.

- **Gateway** — `POST /v1/chat/completions` (OpenAI dialect, streaming supported),
  `POST /v1/messages` (Anthropic dialect), `GET /v1/models`. Bearer auth with a Relayn key.
- **Dashboard** — overview metrics, usage logs with filters and per-request detail, API key
  lifecycle, model catalogue, integration snippets, the one-time Unlimited purchase, support
  tickets, profile.
- **Admin** — users, models, provider status, subscriptions, tickets, audit log; gated
  server-side.

Stack: Next.js 16 (App Router) · React 19 · TypeScript strict · Tailwind CSS v4 ·
Prisma 7 · Zod 4 · Recharts. SQLite by default, PostgreSQL for production.

---

## Quick start

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run dev
```

The app is served on **http://localhost:3200**.

### Seeded accounts

`npm run db:seed` is idempotent and creates clearly-labelled demo data (every seeded usage
row is marked as sample data, so it is never confused with production traffic):

| Account | Email | Password | Plan |
| --- | --- | --- | --- |
| Admin | `admin@relayn.dev` | `relayn-demo-2026` | Enterprise |
| User | `demo@relayn.dev` | `relayn-demo-2026` | Pro |

Override with `SEED_DEMO_PASSWORD` before seeding. Registering a fresh account puts you on the
Free plan with an empty dashboard — every card and chart then shows a professional empty state
rather than invented statistics.

### Sign in with Google (optional)

Password sign-in works out of the box. To add a "Continue with Google" button, create an
OAuth client in **Google Cloud Console → APIs & Services → Credentials → OAuth client ID →
Web application** and register the callback for every origin you sign in from:

```
http://localhost:3200/api/auth/oauth/google/callback
```

```
https://<your-domain>/api/auth/oauth/google/callback
```

Then put the pair in `.env`:

```bash
GOOGLE_OAUTH_CLIENT_ID="…apps.googleusercontent.com"
```

```bash
GOOGLE_OAUTH_CLIENT_SECRET="GOCSPX-…"
```

The callback path is derived from `APP_URL`, so `APP_URL` must match the origin in the
browser's address bar — a mismatch is what produces Google's `redirect_uri_mismatch`. While
the consent screen is unpublished, add your own address under **Test users** or Google will
refuse the sign-in. With either variable empty the button is not rendered at all, and the
route redirects to `/login?error=oauth_unavailable` rather than failing obscurely.

A first Google sign-in for an address that already has a password account **links** to it
(Google has verified the address, which is the proof of ownership that makes this safe) and
records `auth.oauth_linked` in the audit log. A first sign-in for an unknown address creates a
Free-plan account with no password; its owner can set one later on `/profile`, and can connect
or disconnect Google from the same page.

### First request

Create a key on `/api-keys` (the secret is shown exactly once), then:

```bash
curl http://localhost:3200/v1/chat/completions -H "Authorization: Bearer $RELAYN_KEY" -H "Content-Type: application/json" -d '{"model":"relayn-sandbox-chat","messages":[{"role":"user","content":"Hello"}]}'
```

`relayn-sandbox-chat` is served by the built-in deterministic mock provider, so this works
with no upstream credentials at all. Add `OPENAI_API_KEY` (or Anthropic / Google /
OpenRouter) to `.env` to unlock the real models in the catalogue — a provider with no key
stays *unconfigured* and its models return `503 provider_unconfigured` instead of failing
silently. For an OpenAI-compatible aggregator, set its key and base URL and then run
`npm run models:sync` to discover what it actually serves.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 3200 (Turbopack) |
| `npm run build` / `npm start` | Production build and serve |
| `npm run vercel-build` | What Vercel runs: generate + `migrate deploy` + build |
| `npm run lint` / `npm run typecheck` | `tsc --noEmit` (ESLint is not installed) |
| `npm run db:migrate` | Apply migrations to the dev database |
| `npm run db:deploy` | Apply migrations non-interactively (production) |
| `npm run db:seed` | Seed models, plans, demo users and sample usage |
| `npm run db:reset` | Drop, re-migrate and re-seed |
| `npm run db:sync` | Regenerate `prisma/schema.postgres.prisma` from the SQLite schema |
| `npm run db:studio` | Prisma Studio |
| `npm run admin:promote -- <email>` | Promote an account to admin (`--revoke` to demote) |
| `npm run models:sync [provider…]` | Pull each configured provider's `/models` into the catalogue |
| `npm test` | Vitest unit suites (173 tests) |
| `npm run test:e2e` | End-to-end HTTP smoke test against a running dev server |

---

## Environment variables

Everything has a working default except `SESSION_SECRET`, which is **required in
production** — the app refuses to sign sessions with a fallback when `NODE_ENV=production`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `file:./dev.db` | Prisma connection string |
| `PRISMA_SCHEMA` | `prisma/schema.prisma` | Set to `prisma/schema.postgres.prisma` for Postgres |
| `APP_URL` | `http://localhost:3200` | Origin used in doc snippets and email links |
| `SESSION_SECRET` | — | 32+ bytes; HMAC key for session fingerprints |
| `SESSION_TTL_DAYS` | `7` | Session lifetime |
| `RATE_LIMIT_PER_MINUTE` | `60` | Gateway requests per key per minute (plan overrides apply) |
| `RATE_LIMIT_AUTH_PER_MINUTE` | `10` | Login/register attempts per IP per endpoint |
| `ENABLE_MOCK_PROVIDER` | `true` outside production | Serves `provider="mock"` models locally |
| `EMAIL_TRANSPORT` | `log` | `log` writes verification/reset links to the server log |
| `EMAIL_FROM` | `no-reply@relayn.dev` | Sender address |
| `OPENAI_API_KEY` | — | Unlocks OpenAI-provider models |
| `ANTHROPIC_API_KEY` | — | Unlocks Anthropic-provider models |
| `GOOGLE_API_KEY` | — | Unlocks Google-provider models |
| `OPENROUTER_API_KEY` | — | Unlocks OpenRouter-provider models |
| `JEROUTER_API_KEY` | — | Unlocks the jerouter aggregator |
| `JEROUTER_BASE_URL` | `https://jerouter.web.id/v1` | Its OpenAI-compatible root |
| `MADEFAKA_API_KEY` | — | Unlocks the madefaka aggregator |
| `MADEFAKA_BASE_URL` | `https://api.madefaka.my.id/v1` | Its OpenAI-compatible root |
| `PROVIDER_CREDENTIAL_KEY` | derived from `SESSION_SECRET` | 64 hex chars; seals credentials of providers added from the dashboard |
| `GOOGLE_OAUTH_CLIENT_ID` | — | Enables "Continue with Google" sign-in |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | Its client secret; server-only |

Each provider also accepts a `*_BASE_URL` override. Provider credentials are read only in
`src/lib/env.ts`, which is `import "server-only"` — they are never serialised into a
client payload.

Any upstream that speaks the OpenAI `/chat/completions` dialect needs no adapter of its own:
jerouter and madefaka are both instances of `OpenAiCompatibleProvider`, configured by nothing
more than a key and a base URL. Their models are **not** hand-seeded — see the next section.

---

## Adding a provider without a redeploy

**Admin → Providers → Add provider** registers an upstream at runtime. Two dialects are
offered, which between them cover most of what is resellable:

| Dialect | Wire call | Auth |
| --- | --- | --- |
| OpenAI-compatible | `POST {baseUrl}/chat/completions`, `GET {baseUrl}/models` | `Authorization: Bearer …` |
| Anthropic-compatible | `POST {baseUrl}/messages`, `GET {baseUrl}/models` | `x-api-key` + `anthropic-version` |

The form asks for a display name, an immutable provider id (lowercase, dashes — it becomes the
prefix of every model id this provider serves, as `<id>/<upstream-id>`), the base URL, the
credential, and optionally extra request headers as a JSON object. **Load its model catalogue
now** runs the same sync as `npm run models:sync`, scoped to the new provider, so a working
upstream is routable the moment it is added. Each row then offers *Test* (a live probe reporting
health, latency, model count and a sample of ids), *Sync models*, *Edit*, *Rotate key*,
*Enable/Disable* and *Delete*.

Three things are deliberate here:

**The credential is sealed, not hashed.** A stored API key has to be replayable — the gateway
presents it to the upstream on every call — so it is encrypted with AES-256-GCM under
`PROVIDER_CREDENTIAL_KEY` (or, unset, a key derived from `SESSION_SECRET` via HKDF-SHA256) and
decrypted only inside the request path. It is never returned by an API route: rows carry the last
four characters and nothing else, the key field is write-only and starts empty, and *Edit* does
not render a credential field at all — which is what makes "fix the label without knowing the
key" possible. Rotating either secret leaves existing rows unopenable and each provider has to be
re-entered; the failure is explicit (`sealed with a different key — re-enter it`), never silent.

**A row cannot shadow a builtin.** `openai`, `anthropic`, `google`, `openrouter`, `mock`,
`jerouter` and `madefaka` are refused as ids, and even if one reached the table the registry
composes builtins last, so they win. Nor can a stored header override the credential: a row's
`authorization`, `x-api-key`, `content-type`, `anthropic-version` or `host` is dropped before the
request is built.

**Deletion is blocked while models exist.** Removing a provider that still has catalogue rows
would orphan them, so the API refuses with a 403 until the models are removed; the same reason
there is no rename. A provider that is merely wrong can be disabled instead, which takes it out
of routing immediately while leaving its rows intact.

---

## Catalogue sync

Aggregators add and drop models constantly, so their entries are discovered rather than
written by hand. Either route works and both do the same thing:

```bash
npm run models:sync
```

or **Admin → Models → “Sync from providers”**, which reports per-provider counts inline and
writes an `admin.models_synced` audit row.

Sync calls `GET /models` on every configured provider that can list one, and reconciles the
result against the catalogue:

- **New model** → row created in full. `category` is inferred from the id, `minPlan` from the
  published output price (free only when the price is genuinely zero or unpublished, `pro` up
  to \$2/M, `business` above that), so a priced model can never land on the Free tier by
  default.
- **Known model** → only upstream-owned facts are refreshed: provider, upstream id, context
  window, max output, and pricing when published. Operator decisions — `enabled`, `minPlan`,
  `description`, `sortOrder` — are never overwritten.
- **Gone from upstream** → reported as *stale* and left enabled. Disabling someone's working
  model because an upstream had a bad minute is not a decision to automate.

Catalogue ids are namespaced `<provider>/<upstream-id>` (`jerouter/f/deepseek-v4-flash`), while
`upstreamModel` keeps whatever the upstream itself expects. A provider with no credential is
skipped by name, not silently.

`/models` payloads are only loosely standardised past `{id, object, owned_by}`, and the unit
differences matter: OpenRouter publishes USD **per token**, most gateways publish USD **per
million**, and plenty publish nothing at all. The adapter normalises everything to per-million
(the unit `costMicroUsd` multiplies by) and leaves an unpublished price *absent* — writing a
confident `0` would meter a paid model as free forever. Unpublished limits render as “—”
rather than a misleading `0`.

### Usage is reconciled, not trusted

Some gateways publish a usage block that contradicts their own response body: jerouter's
terminal stream chunk reads `{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10}`
next to a full answer. Recording that verbatim under-debits the caller's allocation and
under-reports the dashboard's token counts, so `reconcileUsage` estimates the output half
locally whenever zero output is reported alongside real text, while still preferring the
reported prompt count — that half is not in doubt. A genuinely empty response (tool-calls
only) stays at zero, and any row whose numbers were estimated is flagged `usageEstimated`.

---

## Architecture

```
src/
  proxy.ts                  Network-boundary hook: issues the double-submit CSRF cookie
  app/
    (auth)/                 login · register · forgot-password · reset-password · verify-email
    (dashboard)/            dashboard · usage · api-keys · models · integrations ·
                            subscription · support · profile · docs · admin/*
    api/                    Control plane (session-authenticated, CSRF-protected)
    v1/                     Gateway (Bearer-authenticated, cookie-free)
  lib/
    auth/                   Session issue/verify (session.ts) + requireUser/requireAdmin (guards.ts)
    security/               password · tokens · csrf · rate-limit
    gateway/                pipeline.ts (the 13 steps) · schemas.ts · respond.ts
    providers/              registry.ts + openai-compatible · anthropic · mock adapters
    usage/                  accounting.ts (cost) · tokenizer.ts (fallback estimation) · metrics.ts
    api/                    Zod schemas + the `ok()` / error-envelope helpers
    plans.ts, snippets.ts   Plan gating; the doc snippets rendered on /docs and /integrations
  server/services/          All database access. Every query is scoped by userId.
```

### The gateway request pipeline

`src/lib/gateway/pipeline.ts` executes in a fixed order, and each step has its own error
code so a client can tell what went wrong:

1. Extract the Bearer key (or Anthropic `x-api-key`) → `missing_api_key` (401)
2. Hash it (SHA-256) and look it up → `invalid_api_key` (401)
3. Check key status → `api_key_revoked` (401); account status → `account_suspended` (403)
4. Check subscription status → `subscription_inactive` (402)
5. Check the token allocation → `insufficient_tokens` (402)
6. Resolve the model → `model_required` (400) · `model_not_found` (404) ·
   `model_disabled` (503) · `model_not_available_on_plan` (403)
7. Resolve the provider → `provider_not_registered` / `provider_unconfigured` (503)
8. Rate-limit per key, then per account → `rate_limit_exceeded` (429) with `Retry-After`
9. Forward upstream through the `ModelProvider` adapter (streaming or buffered)
10. Read the usage block, or estimate it with the tokenizer when the provider omits one
11. Compute cost in **integer micro-USD** (`costMicroUsd`) — floats are never accumulated
12. Write the usage row and increment `tokensUsed` in one transaction
13. Return an OpenAI-compatible response with the measured latency

A failed request is still logged, with its error code, so the dashboard's success rate is
computed from real outcomes.

---

## Security model

**Passwords** — scrypt (N=16384, r=8, p=1), 16-byte random salt, 64-byte key, NFKC-normalised
input, stored as `scrypt$N$r$p$salt$hash`. Verification uses `timingSafeEqual`. Plaintext is
never written anywhere.

**Sessions** — opaque random token in an `httpOnly`, `sameSite=lax`, `secure`-in-production
cookie, bound to an HMAC fingerprint keyed by `SESSION_SECRET` (only the fingerprint is stored,
so a database read does not yield usable cookies). `createSession` always mints a fresh token
rather than promoting a pre-existing one, which closes session fixation; a password change
calls `revokeAllSessions` to invalidate every other session.

**API keys** — 32 bytes from `crypto.randomBytes`, base64url, prefixed `rly_live_`. Only the
SHA-256 hash and the last four characters are persisted; the plaintext exists once, in the
creation response, and is never retrievable afterwards.

**Sign in with Google** — OpenID Connect authorization-code flow with PKCE (S256). The
`state`, the PKCE verifier and the `nonce` are sealed into one HMAC-signed, `httpOnly`
cookie keyed by `SESSION_SECRET`; the callback deletes that cookie before validating
anything, so a replayed callback URL cannot be completed twice. `state` is compared in
constant time, and the ID token's `iss`, `aud`, `exp` and `nonce` are all checked — the JWS
signature is not re-verified because the token is read from the body of a direct TLS request
to Google's token endpoint, which OIDC Core §3.1.3.7 permits; a token arriving any other way
is never accepted. Accounts are keyed on Google's immutable `sub`, never on the email, and an
unverified address is refused outright, which is what makes "same email → link to the
existing account" safe. Provider-created accounts have `passwordHash = NULL` — treated as
"never matches", not as an empty password — and can set a first password from the profile
page. The whole feature disables itself cleanly when the two `GOOGLE_OAUTH_*` variables are
unset: the button disappears and the start route redirects with `?error=oauth_unavailable`
rather than half-working.

**CSRF** — double submit plus an Origin/Referer host check, and both must pass. The cookie is
issued at the network boundary in `src/proxy.ts` (Next.js forbids cookie writes during a
layout render) and rotated on login and register, so a value planted before authentication
cannot be replayed after it. `/v1` is excluded: it is Bearer-authenticated and cookie-free,
so it is not reachable by a cross-site form post.

**Authorisation and IDOR** — `requireUser()` / `requireAdmin()` guard every route handler, and
`(dashboard)/layout.tsx` plus a nested `admin/layout.tsx` gate the pages server-side. Every
service query carries `userId` in its `where` clause, so a single-row read for another user's
record misses and returns **404**, not 403 — the response does not confirm the row exists.
Model visibility is filtered by plan on the server, so `/v1/models` never lists a model the
caller cannot call.

**Rate limiting** — fixed-window counters, per key first and then per account (twice the
per-key ceiling), plus per-IP limits on the auth endpoints. 429 responses carry
`Retry-After`, `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`. The store
is in-process and single-instance by design; `RateLimitStore` in
`src/lib/security/rate-limit.ts` is the injection seam for Redis in a cluster.

**Other** — Zod parses every mutating body and query string; Prisma parameterises all SQL;
React escapes all rendered output and no `dangerouslySetInnerHTML` is used; a
Content-Security-Policy, `X-Frame-Options: DENY` and the rest are set in `next.config.ts`;
privileged actions append to an audit log that application code only ever inserts into and
reads — there is no update or delete path.

---

## Testing

Two layers, both runnable now.

```bash
npm test
```

512 unit tests across 22 suites (`tests/`): credential primitives and key generation, scrypt
password storage, plan gating, rate limiting (fake timers, window rollover, the account-wide
ceiling, the Redis seam), CSRF (Origin spoofing, look-alike hosts, token mismatch), token
accounting and cost maths, Zod schema boundaries, the OpenAI-compatible adapter (`/models`
price-unit normalisation, upstream status mapping, usage reconciliation), the Anthropic dialect
(catalogue pagination, system-turn hoisting, usage estimation), credential sealing (tamper and
wrong-key rejection, the four-character hint), provider-registry composition (a row cannot shadow
a builtin, protected headers are dropped, an undecryptable key degrades to unconfigured), Google
OAuth (sealed state, PKCE challenge, id-token claim handling), both payment rails (QRIS callback
signature verification and idempotency, the on-chain verifier's amount, recipient, confirmation
and replay rules, and the browser wallet's chain checks), number and money formatters, the
catalogue-sync heuristics (category, tier, name), and the documentation snippets — the last suite
is a regression guard for a real bug where every sample built a `/v1/v1/...` URL.

```bash
npm run test:e2e
```

`scripts/e2e-smoke.sh` drives the running dev server over real HTTP: 79 assertions in 14
sections covering CSRF issuance and enforcement, registration, protected pages and the admin
gate, key creation (and that the secret never reappears), a gateway completion, the usage row
it produced, IDOR probes against a second user's records, the Free-plan key limit, revocation,
logout/login, plan-based model authorisation, streaming, the Anthropic dialect at
`/v1/messages` (`x-api-key` auth, response shape, the full SSE event sequence, its error
envelope), and rate limiting. It also asserts the *numbers*: that a completion moves
`tokensRemaining`, `requestsToday` and `tokensUsedToday` by exactly the amount the response
reported, and that every streamed call has a `usage_logs` row — looked up by the response's
`x-request-id`, with no sleep, so accounting that finished after the stream closed would fail
the run rather than pass by luck. Start `npm run dev` first.

`BASE` overrides the target, so the same suite verifies a real deployment rather than only
localhost — this is how the Vercel/PostgreSQL path below was checked:

```bash
BASE="https://your-project.vercel.app" npm run test:e2e
```

Section 14 is opt-in, because a suite that depends on a third-party credential staying funded
is a suite that fails for the wrong reason. Name a model your test account may call and it
runs a live buffered and streamed completion, asserting the usage row it produced — including
non-zero output tokens on the streamed one, the regression guard for the reconciliation above:

```bash
E2E_UPSTREAM_MODEL=jerouter/f/deepseek-v4-flash npm run test:e2e
```

It registers two throwaway `@relayn.test` accounts and leaves their rows behind, so delete
them afterwards when you point it at a production database.

---

## Deploying to Vercel

SQLite cannot be used on Vercel — the filesystem is read-only and per-instance, so writes
would be lost. A managed PostgreSQL database is required (Vercel Postgres, Neon, Supabase,
Prisma Postgres — any of them; only the connection string differs).

**1. Create the database** and copy its pooled connection string.

**2. Set the environment variables** in the Vercel project (Production *and* Preview):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the PostgreSQL connection string |
| `PRISMA_SCHEMA` | `prisma/schema.postgres.prisma` |
| `SESSION_SECRET` | 48 random bytes — `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `APP_URL` | the **public** origin you serve on, with no trailing slash — a custom domain such as `https://bandidoz.biz.id` if you have one, otherwise `https://<your-project>.vercel.app`. Every absolute URL the server builds (OAuth `redirect_uri`, verification and reset links, payment return URL, `metadataBase`) comes from this, so a deployment reachable on several hostnames still advertises exactly one |
| `ENABLE_MOCK_PROVIDER` | `true` to keep the sandbox models callable on the demo, otherwise omit |
| `OPENAI_API_KEY` etc. | only for the providers you actually want to serve |
| `JEROUTER_API_KEY` / `MADEFAKA_API_KEY` | the OpenAI-compatible aggregators, if you use them |
| `PROVIDER_CREDENTIAL_KEY` | 32 random bytes as hex — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Seals the credentials of providers added from Admin → Providers. Optional (it is otherwise derived from `SESSION_SECRET`), but set it before you add any: rotating `SESSION_SECRET` later would make those stored credentials unopenable and each provider would have to be re-entered |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | only if you want Google sign-in; add `<APP_URL>/api/auth/oauth/google/callback` to the OAuth client's authorised redirect URIs. It must match `APP_URL` exactly — if you later move to a custom domain, register the new callback *before* changing `APP_URL`, or sign-in fails with `redirect_uri_mismatch` |

Aggregator catalogues are per-database, so after the first deploy run a sync against
production once — `DATABASE_URL=… PRISMA_SCHEMA=prisma/schema.postgres.prisma npm run
models:sync`, or the admin button while signed in as an admin — otherwise their models exist
in `.env` but not in the catalogue.

`SESSION_SECRET` is mandatory: with `NODE_ENV=production` the app throws rather than sign
sessions with a development fallback. `PRISMA_SCHEMA` is what selects the PostgreSQL schema
*and* the `prisma/migrations-postgres` migration history — miss it and the build migrates
nothing.

**3. Deploy.** Vercel runs the `vercel-build` script, which is
`prisma generate && prisma migrate deploy && next build` — so the schema is applied during
the build and no manual migration step is needed.

New Vercel projects enable **Deployment Protection (Vercel Authentication)** by default, which
intercepts every request — including `/v1` — and 302s it to `vercel.com/sso-api` before the app
sees it. A gateway is unusable behind it: SDK clients get a redirect instead of JSON. Turn it
off under *Settings → Deployment Protection* (or `PATCH /v9/projects/<id>` with
`{"ssoProtection": null}`) once you intend the deployment to be reachable.

**4. Seed the model catalogue** once, from your machine, against the production database.
Without this the catalogue is empty and every gateway call returns `model_not_found`:

```bash
DATABASE_URL="postgresql://..." PRISMA_SCHEMA="prisma/schema.postgres.prisma" SEED_DEMO_DATA=false npm run db:seed
```

`SEED_DEMO_DATA=false` inserts the providers and the model catalogue only — no demo
accounts, so the well-known seed password never exists in production.

**5. Create your admin.** Register through the deployed UI, then promote that account. A local
checkout has a SQLite-targeted client generated, and Prisma 7 bakes the provider in, so point
the client at PostgreSQL first:

```bash
PRISMA_SCHEMA="prisma/schema.postgres.prisma" npx prisma generate
```

```bash
DATABASE_URL="postgresql://..." npm run admin:promote -- you@example.com
```

```bash
npx prisma generate
```

The last line restores the SQLite client so local development keeps working. The script checks
the two agree and tells you which command to run if they do not, rather than failing inside the
query compiler.

Registration always creates `role: "user"`, deliberately — the admin panel cannot be reached
by signing up. `--revoke` demotes again, and either way the change is written to the audit log.

### What changes on serverless

- **Rate limiting becomes per-instance.** The fixed-window counters live in process memory,
  so with *n* warm lambdas the effective ceiling is up to *n* times the configured one.
  Correctness of quota enforcement is unaffected — that is a database counter — but the
  429s are advisory rather than exact. Wire `RateLimitStore` in
  `src/lib/security/rate-limit.ts` to Redis (Upstash) if the limit must be authoritative.
- **Use a pooled connection string.** Each lambda opens its own pool; a direct Postgres
  connection will exhaust `max_connections` under load.
- **Streaming works** (the gateway returns a standard `ReadableStream` SSE response), but
  responses are bounded by the plan's function timeout — 60s on Hobby. The usage row for a
  streamed call is committed *before* the stream is closed, deliberately: an instance may
  freeze the moment the response ends, so work awaited after `controller.close()` is simply
  lost and the call would go unmetered.
- `ENABLE_MOCK_PROVIDER` defaults to **false** in production, so the seeded
  `relayn-sandbox-*` models return `503 provider_unconfigured` unless you opt in.

### PostgreSQL elsewhere

The same two variables work for any host — containers, Fly, a VPS:

```bash
DATABASE_URL="postgresql://user:pass@host:5432/relayn?schema=public" PRISMA_SCHEMA="prisma/schema.postgres.prisma" npm run db:deploy
```

`prisma/schema.postgres.prisma` is generated from the canonical schema by `npm run db:sync`,
so the two cannot drift. Money is stored as integer micro-USD and token counts as integers,
so no numeric-precision behaviour changes between engines.

---

## Deliberate omissions

- **No recurring billing.** There is exactly one thing to buy — permanent `unlimited` for
  $0.50, charged once — and it is granted only by a chain-verified USDC transfer
  (`/api/payments/crypto/verify`) or a signature-verified provider callback
  (`/api/payments/callback`). No card is ever stored or charged, `billingConnected` stays
  false, and `/api/subscription` is `GET`-only: no request body can name a plan.
- **No monthly tier ladder.** `pro`/`business`/`enterprise` remain as account states an
  operator may assign; nothing sells them, so nothing advertises them.
- **No email delivery.** `EMAIL_TRANSPORT=log` writes verification and reset links to the
  server log; the token flow itself is fully implemented and tested.
- **Provider keys are optional.** Every adapter is complete, but a provider with no
  credential reports itself unconfigured and its models return `503 provider_unconfigured`
  rather than pretending to work.

