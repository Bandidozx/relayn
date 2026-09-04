import type { Metadata } from "next";
import Link from "next/link";
import { FaqList, type FaqEntry } from "@/components/support/faq-list";
import { SupportCentre } from "@/components/support/support-centre";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { listTickets } from "@/server/services/support-service";

export const metadata: Metadata = { title: "Support" };

const FAQ: FaqEntry[] = [
  {
    question: "Which base URL and auth header should I use?",
    answer: (
      <>
        Point any OpenAI-compatible client at <span className="numeric text-ink">/v1</span> on this
        deployment and send <span className="numeric text-ink">Authorization: Bearer rly_live_…</span>
        . The Integrations page generates working snippets for cURL, Python, Node and plain REST.
      </>
    ),
  },
  {
    question: "I lost my API key. Can you resend it?",
    answer: (
      <>
        No — and that is deliberate. We store only a SHA-256 hash of each key, so there is no code
        path that can reveal one after creation. Revoke the lost key on the{" "}
        <span className="numeric text-ink">API keys</span> page and create a replacement.
      </>
    ),
  },
  {
    question: "Why did I get a 429?",
    answer: (
      <>
        Either the per-minute request limit for your plan or the per-key burst limit was exceeded.
        The response includes <span className="numeric text-ink">retry-after</span> and the limit
        that tripped. Rate limits are per user, per key and per IP, so a shared IP behind NAT can
        also hit the IP limit.
      </>
    ),
  },
  {
    question: "What happens when I run out of tokens?",
    answer: (
      <>
        Requests fail with <span className="numeric text-ink">402 quota_exhausted</span> until the
        cycle resets or you switch plans. The Budget runway card on the overview projects when that
        will happen based on your last seven active days.
      </>
    ),
  },
  {
    question: "Do you store my prompts and completions?",
    answer: (
      <>
        No. Usage records keep metadata only — model, endpoint, token counts, latency, status,
        request id and client IP. Message content is never written to the database, which is why the
        request detail dialog shows no prompt text.
      </>
    ),
  },
  {
    question: "Is billing connected?",
    answer: (
      <>
        Not in this deployment. Plan changes take effect immediately and are written to the audit
        log; no card is charged. The Subscription page explains exactly where a payment processor
        would plug in.
      </>
    ),
  },
  {
    question: "A model returns 403 model_not_allowed. Why?",
    answer: (
      <>
        The model exists but sits above your plan tier. The Models page marks those cards with the
        plan they need. The gateway re-checks this on every request, independently of the UI.
      </>
    ),
  },
];

export default async function SupportPage() {
  const { user } = await requireUser();
  const tickets = await listTickets(user.id);

  return (
    <>
      <PageHeader
        title="Support"
        description="Search the FAQ first — most answers are there. If not, open a ticket and it lands in the same thread you can follow here."
      />

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <FaqList entries={FAQ} />

        <Card>
          <CardHeader
            title="Other ways to get unstuck"
            description="Self-serve first: these usually answer the question faster than a ticket."
          />
          <CardBody className="space-y-2.5">
            {[
              {
                href: "/docs",
                title: "API reference",
                body: "Endpoints, error codes, streaming, rate limits and usage tracking.",
              },
              {
                href: "/usage",
                title: "Usage logs",
                body: "Find the failing request, copy its request id, attach it to your ticket.",
              },
              {
                href: "/models",
                title: "Model catalogue",
                body: "Check context windows, pricing and which plan each model needs.",
              },
              {
                href: "/integrations",
                title: "Integration snippets",
                body: "Copy a request that is known to work, then diff it against yours.",
              },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded-xl border border-line px-3.5 py-3 transition-colors hover:border-line-strong hover:bg-hover"
              >
                <p className="text-sm text-ink">{item.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{item.body}</p>
              </Link>
            ))}
            <p className="pt-1 text-[11px] leading-relaxed text-ink-faint">
              Signed in as <span className="text-ink">{user.email}</span> — replies appear in your
              ticket thread on this page, not by email, because this build has no mail transport
              configured.
            </p>
          </CardBody>
        </Card>
      </div>

      <SupportCentre initialTickets={tickets} />
    </>
  );
}
