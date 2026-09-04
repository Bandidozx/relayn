/**
 * `/api/health` — the one endpoint anyone on the internet can call.
 *
 * Two things it has to get right. First, "healthy" must mean *can serve traffic*: a deployment
 * whose database is unreachable renders every static page fine while failing every gateway call,
 * which is precisely the state a health check exists to catch — so a 200 that does not depend on
 * the database would be worse than no probe at all. Second, it must stay boring: the body carries
 * `ok` and nothing else, because an operator's upstream topology, versions and error text are not
 * public information.
 *
 * The memoisation is asserted too. Without it, an unauthenticated endpoint is a free way to turn
 * one HTTP request into one database query.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));

type Route = typeof import("@/app/api/health/route");

/** Fresh module, because the 5-second cache lives in a module-level variable. */
async function load(): Promise<Route> {
  vi.resetModules();
  return import("@/app/api/health/route");
}

beforeEach(() => {
  queryRaw.mockReset().mockResolvedValue([{ 1: 1 }]);
  // The probe races a 3s timer; fake timers keep the failure case from actually waiting.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/health", () => {
  it("answers 200 {ok:true} when the database responds", async () => {
    const { GET } = await load();
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("answers 503 {ok:false} when the database does not", async () => {
    queryRaw.mockRejectedValue(new Error("ECONNREFUSED db.example.neon.tech:5432"));
    const { GET } = await load();
    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it("keeps the failure reason server-side", async () => {
    // The connection string and the driver's wording are infrastructure detail. A monitor gets
    // the status code; the log gets the cause.
    queryRaw.mockRejectedValue(new Error("password authentication failed for user \"neondb_owner\""));
    const { GET } = await load();
    const body = await (await GET()).text();

    expect(body).toBe('{"ok":false}');
    expect(body).not.toContain("neondb_owner");
    expect(console.error).toHaveBeenCalled();
  });

  it("returns exactly one field, so nothing about the deployment leaks by accident", async () => {
    const { GET } = await load();
    const payload = (await (await GET()).json()) as Record<string, unknown>;

    expect(Object.keys(payload)).toEqual(["ok"]);
  });

  it("is never cached by an intermediary", async () => {
    const { GET } = await load();
    expect((await GET()).headers.get("cache-control")).toBe("no-store");
  });
});

describe("probe memoisation", () => {
  it("serves a burst from one query", async () => {
    const { GET } = await load();
    await Promise.all([GET(), GET(), GET(), GET()]);

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the window has passed, so recovery is noticed", async () => {
    vi.useFakeTimers();
    const { GET } = await load();

    queryRaw.mockRejectedValue(new Error("down"));
    expect((await GET()).status).toBe(503);

    queryRaw.mockResolvedValue([{ 1: 1 }]);
    // Still inside the 5s window: the cached failure stands.
    vi.setSystemTime(Date.now() + 4_000);
    expect((await GET()).status).toBe(503);

    vi.setSystemTime(Date.now() + 2_000);
    expect((await GET()).status).toBe(200);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("HEAD /api/health", () => {
  it("mirrors GET's status with no body", async () => {
    const { HEAD } = await load();
    const response = await HEAD();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("mirrors a failure too, so a HEAD monitor is not lied to", async () => {
    queryRaw.mockRejectedValue(new Error("down"));
    const { HEAD } = await load();

    expect((await HEAD()).status).toBe(503);
  });
});
