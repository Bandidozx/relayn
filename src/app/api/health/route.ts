/**
 * GET /api/health — unauthenticated liveness probe.
 *
 * Shaped for uptime monitors and for an agent checking whether a gateway is worth talking to
 * before it sends a real request: `{"ok":true}` when the deployment can serve traffic, the same
 * body with `ok:false` and HTTP 503 when it cannot. A monitor should be able to branch on the
 * status code alone.
 *
 * "Can serve traffic" means the database answers, because every gateway request needs it — the
 * API key lookup, the catalogue row and the usage write all go through Prisma. A deployment whose
 * database is unreachable returns 200 on every static page while failing every real call, which
 * is precisely the state a health check exists to catch.
 *
 * Deliberately says nothing else. No provider names, model counts, versions, environment values
 * or error text: this endpoint is reachable by anyone, and an operator's upstream topology is not
 * public information. The database failure reason is logged server-side instead.
 *
 * The result is memoised for a few seconds, and concurrent probes are coalesced into one query,
 * so a monitor (or a flood) cannot turn an unauthenticated endpoint into one database query per
 * request.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Long enough to absorb a burst, short enough that recovery is noticed quickly. */
const CACHE_MS = 5_000;

/** A probe that hangs is a failed probe: a monitor must not be left waiting on our behalf. */
const TIMEOUT_MS = 3_000;

let cached: { ok: boolean; at: number } | null = null;

/** The probe currently running, shared by every caller that arrives while it is in flight. */
let inFlight: Promise<boolean> | null = null;

async function databaseReachable(): Promise<boolean> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("health probe timed out")), TIMEOUT_MS),
      ),
    ]);
    return true;
  } catch (error) {
    // Reason stays server-side; the response body must not describe our infrastructure.
    console.error("[relayn:health] database probe failed:", error);
    return false;
  }
}

/**
 * Coalesces concurrent probes into one query.
 *
 * The result cache alone is not enough: it is written *after* the query resolves, so a burst of
 * simultaneous requests would each find it empty and each open their own connection — which is
 * the exact load an unauthenticated endpoint has to be able to absorb.
 */
function probe(): Promise<boolean> {
  inFlight ??= databaseReachable().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) {
    // Timestamped when the answer is known, not when the request arrived, so a slow probe does
    // not spend most of its own window.
    cached = { ok: await probe(), at: Date.now() };
  }

  return NextResponse.json(
    { ok: cached.ok },
    {
      status: cached.ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}

export async function HEAD(): Promise<Response> {
  const response = await GET();
  return new Response(null, { status: response.status, headers: response.headers });
}
