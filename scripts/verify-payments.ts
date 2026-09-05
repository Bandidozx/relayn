/**
 * End-to-end verification of the one-time unlimited purchase, against the real database.
 *
 * The Vitest suite covers the pure decision layer (`tests/payments-rules.test.ts`), the adapter
 * (`tests/payments-tripay.test.ts`) and the display layer. What it cannot cover is the part
 * that only exists as SQL: the conditional UPDATE that makes activation idempotent, the
 * owner-scoped read, and `ensureSubscription`'s refusal to roll an unlimited row. Those need
 * rows, so they are verified here.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-payments.ts
 *
 * Every row this creates is removed again in a `finally` block, including on failure. Accounts
 * are named `payverify-<random>@relayn.test` so a crashed run is identifiable and deletable.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import {
  ADMIN_ASSIGNABLE_PLAN_ORDER,
  UNLIMITED_PLAN_ID,
  UNLIMITED_PRICE_IDR,
  UNLIMITED_TOKEN_ALLOCATION,
  planSatisfies,
} from "../src/lib/plans";
import { applyVerifiedPayment, getPaymentForUser } from "../src/server/services/payment-service";
import { ensureSubscription, quotaFrom } from "../src/lib/usage/accounting";
import { describeQuota } from "../src/lib/usage/quota-display";
import type { CallbackEvent } from "../src/lib/payments/types";

const PROVIDER = "tripay";
const suffix = randomBytes(4).toString("hex");
const createdUserIds: string[] = [];
const startedAt = new Date();

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectRejection(label: string, run: () => Promise<unknown>, match: RegExp) {
  try {
    await run();
    check(label, false, "no error was thrown");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, match.test(message), `message was: ${message}`);
  }
}

async function makeUser(tag: string) {
  const user = await prisma.user.create({
    data: {
      email: `payverify-${tag}-${suffix}@relayn.test`,
      name: `Pay Verify ${tag}`,
      // Not a usable credential: this account never signs in. Hashed column, random value.
      passwordHash: `verify-only-${randomBytes(16).toString("hex")}`,
      role: "user",
      status: "active",
    },
  });
  createdUserIds.push(user.id);
  await ensureSubscription(user.id);
  return user;
}

/** A pending order in exactly the shape `startUnlimitedCheckout` writes. */
async function makeOrder(userId: string, over: { amount?: number; reference?: string } = {}) {
  return prisma.payment.create({
    data: {
      userId,
      orderId: `RLY-VERIFY-${randomBytes(5).toString("hex").toUpperCase()}`,
      provider: PROVIDER,
      plan: UNLIMITED_PLAN_ID,
      amount: over.amount ?? UNLIMITED_PRICE_IDR,
      method: "QRIS",
      status: "pending",
      reference: over.reference ?? `VERIFY-${randomBytes(6).toString("hex")}`,
      qrString: "00020101021226…verify",
    },
  });
}

function callback(
  orderId: string,
  reference: string,
  over: Partial<CallbackEvent> = {},
): CallbackEvent {
  return {
    orderId,
    reference,
    status: "paid",
    amountIdr: UNLIMITED_PRICE_IDR,
    grossAmountIdr: UNLIMITED_PRICE_IDR,
    paidAt: new Date(),
    method: "QRIS",
    ...over,
  };
}

async function main() {
  console.log(`\nPayment verification (suffix ${suffix})\n`);

  // ── 7. A user who has not paid stays Free ─────────────────────────────────────────────
  console.log("An unpaid account");
  const alice = await makeUser("alice");
  let sub = await ensureSubscription(alice.id);
  check("starts on the Free plan", sub.plan === "free", `plan was ${sub.plan}`);
  check("is not unlimited", sub.unlimited === false);
  check("has no plan expiry", sub.planExpiresAt === null);
  check("reports a finite quota", quotaFrom(sub, alice).unlimited === false);

  // ── 9 / 10. Amount and status gates ───────────────────────────────────────────────────
  console.log("\nThe callback gates");
  const wrongAmountOrder = await makeOrder(alice.id);
  const wrongAmount = await applyVerifiedPayment({
    providerId: PROVIDER,
    event: callback(wrongAmountOrder.orderId, wrongAmountOrder.reference!, { amountIdr: 4_000 }),
    source: "callback",
  });
  check(
    "an amount other than Rp5.000 is rejected",
    wrongAmount.action === "reject" && wrongAmount.reason === "amount_mismatch",
    JSON.stringify(wrongAmount),
  );
  sub = await ensureSubscription(alice.id);
  check("and grants nothing", sub.unlimited === false);

  const wrongReference = await applyVerifiedPayment({
    providerId: PROVIDER,
    event: callback(wrongAmountOrder.orderId, "SOMEONE-ELSES-REFERENCE"),
    source: "callback",
  });
  check(
    "a mismatched provider reference is rejected",
    wrongReference.reason === "reference_mismatch",
    JSON.stringify(wrongReference),
  );

  const unknownOrder = await applyVerifiedPayment({
    providerId: PROVIDER,
    event: callback("RLY-DOES-NOT-EXIST", "REF"),
    source: "callback",
  });
  check(
    "an order we never created is rejected",
    unknownOrder.action === "reject" && unknownOrder.reason === "unknown_order",
  );

  const expiredOrder = await makeOrder(alice.id);
  const expiredResult = await applyVerifiedPayment({
    providerId: PROVIDER,
    event: callback(expiredOrder.orderId, expiredOrder.reference!, { status: "expired" }),
    source: "callback",
  });
  check(
    "a non-PAID status marks the order failed without activating",
    expiredResult.action === "mark_failed" && expiredResult.activated === false,
    JSON.stringify(expiredResult),
  );
  sub = await ensureSubscription(alice.id);
  check("and still grants nothing", sub.unlimited === false, `plan is now ${sub.plan}`);

  // ── 12. A verified PAID callback activates permanent unlimited ─────────────────────────
  console.log("\nA verified Rp5.000 payment");
  const order = await makeOrder(alice.id);
  const first = await applyVerifiedPayment({
    providerId: PROVIDER,
    event: callback(order.orderId, order.reference!),
    source: "callback",
  });
  check("activates on the first delivery", first.activated === true, JSON.stringify(first));

  sub = await ensureSubscription(alice.id);
  check("sets plan = unlimited", sub.plan === UNLIMITED_PLAN_ID, `plan is ${sub.plan}`);
  check("sets status = active", sub.status === "active");
  check("sets unlimited = true", sub.unlimited === true);
  check("leaves planExpiresAt null", sub.planExpiresAt === null);
  check("stores the sentinel allocation", sub.tokenAllocation === UNLIMITED_TOKEN_ALLOCATION);

  const paidRow = await prisma.payment.findUnique({ where: { orderId: order.orderId } });
  check("marks the order paid", paidRow?.status === "paid");
  check("records appliedAt", paidRow?.appliedAt !== null);
  check("records the amount received", paidRow?.paidAmount === UNLIMITED_PRICE_IDR);
  const firstAppliedAt = paidRow?.appliedAt?.getTime() ?? 0;

  // `alice` is a plain `user`, so this asserts the payment alone did it — not a role exemption.
  const quota = quotaFrom(sub, alice);
  check("quotaFrom reports unlimited", quota.unlimited === true);
  check("quotaFrom never reports exhaustion", quota.exhausted === false);
  const display = describeQuota(quota);
  check(
    "the UI descriptor says Unlimited with no bar",
    display.primary === "Unlimited" && display.percent === null && display.renewalLabel === null,
    JSON.stringify(display),
  );

  // ── 11. Idempotency ───────────────────────────────────────────────────────────────────
  console.log("\nRepeated callbacks (TriPay retries three times)");
  const second = await applyVerifiedPayment({
    providerId: PROVIDER,
    event: callback(order.orderId, order.reference!),
    source: "callback",
  });
  const third = await applyVerifiedPayment({
    providerId: PROVIDER,
    event: callback(order.orderId, order.reference!),
    source: "callback",
  });
  check("the second delivery activates nothing", second.activated === false, JSON.stringify(second));
  check("the third delivery activates nothing", third.activated === false);
  check("both are treated as replays, not rejections", second.accepted && third.accepted);

  const afterReplays = await prisma.payment.findUnique({ where: { orderId: order.orderId } });
  check(
    "appliedAt is not rewritten",
    (afterReplays?.appliedAt?.getTime() ?? -1) === firstAppliedAt,
  );
  const activationAudits = await prisma.auditLog.count({
    where: { userId: alice.id, action: "payment.activated" },
  });
  check("activation is audited exactly once", activationAudits === 1, `count was ${activationAudits}`);

  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () =>
      applyVerifiedPayment({
        providerId: PROVIDER,
        event: callback(order.orderId, order.reference!),
        source: "callback",
      }),
    ),
  );
  check(
    "four simultaneous deliveries activate zero further times",
    concurrent.every((result) => result.activated === false),
  );

  // A later refund must not revoke what was paid for.
  const refund = await applyVerifiedPayment({
    providerId: PROVIDER,
    event: callback(order.orderId, order.reference!, { status: "refund" }),
    source: "callback",
  });
  sub = await ensureSubscription(alice.id);
  check("a later refund callback does not downgrade the account", sub.unlimited === true);
  check("and is recorded as an ignored replay", refund.action === "ignore", JSON.stringify(refund));

  // ── 13. ensureSubscription never downgrades ────────────────────────────────────────────
  console.log("\nThe monthly rollover");
  await prisma.subscription.update({
    where: { userId: alice.id },
    // A renewal date well in the past is exactly what would trigger the metered rollover.
    data: { renewalDate: new Date("2020-01-01T00:00:00Z"), tokensUsed: 7_500_000 },
  });
  sub = await ensureSubscription(alice.id);
  check("skips an unlimited row entirely", sub.unlimited === true && sub.plan === UNLIMITED_PLAN_ID);
  check(
    "does not zero the lifetime token total",
    sub.tokensUsed === 7_500_000,
    `tokensUsed is ${sub.tokensUsed}`,
  );
  check("does not move the renewal date", sub.renewalDate.getUTCFullYear() === 2020);

  // ── 14. Every model in the catalogue is reachable ──────────────────────────────────────
  console.log("\nModel authorisation");
  const models = await prisma.aiModel.findMany({ select: { modelId: true, minPlan: true } });
  const blocked = models.filter((model) => !planSatisfies(UNLIMITED_PLAN_ID, model.minPlan));
  check(
    `unlimited reaches all ${models.length} catalogue models`,
    blocked.length === 0,
    blocked.map((model) => model.modelId).join(", "),
  );
  const paidTier = models.filter((model) => model.minPlan !== "free");
  check(
    `including the ${paidTier.length} gated behind a paid tier`,
    paidTier.every((model) => planSatisfies(UNLIMITED_PLAN_ID, model.minPlan)),
  );

  // ── 15. No request-shaped path to or from unlimited ────────────────────────────────────
  console.log("\nNo free upgrade surface");
  const subscriptionRoute = readFileSync(
    new URL("../src/app/api/subscription/route.ts", import.meta.url),
    "utf8",
  );
  check(
    "/api/subscription exposes GET only — no verb can write a plan",
    /export const GET\b/.test(subscriptionRoute) &&
      !["POST", "PATCH", "PUT", "DELETE"].some((verb) =>
        subscriptionRoute.includes(`export const ${verb}`),
      ),
  );
  const subscriptionService = readFileSync(
    new URL("../src/server/services/subscription-service.ts", import.meta.url),
    "utf8",
  );
  check(
    "the subscription service exports no plan mutator",
    !/export (async )?function changePlan\b/.test(subscriptionService),
  );
  check(
    "no operator-assignable plan can reach what a payment grants",
    ADMIN_ASSIGNABLE_PLAN_ORDER.every(
      (id) => !planSatisfies(id, UNLIMITED_PLAN_ID) && id !== UNLIMITED_PLAN_ID,
    ),
  );
  sub = await ensureSubscription(alice.id);
  check("the paid account is still unlimited", sub.unlimited === true);

  const bob = await makeUser("bob");
  const bobSub = await ensureSubscription(bob.id);
  check("a fresh account starts Free", bobSub.plan === "free" && bobSub.unlimited === false);

  // ── Cross-account isolation ───────────────────────────────────────────────────────────
  console.log("\nCross-account isolation");
  await expectRejection(
    "another user cannot read this order by id",
    () => getPaymentForUser(bob.id, order.orderId, { reconcile: false }),
    /not found/i,
  );
  const ownRead = await getPaymentForUser(alice.id, order.orderId, { reconcile: false });
  check("the owner can", ownRead.orderId === order.orderId && ownRead.applied === true);
  check(
    "and the view carries no provider internals",
    !("reference" in ownRead) && !("userId" in ownRead),
    Object.keys(ownRead).join(", "),
  );

  const bobOrder = await makeOrder(bob.id);
  await applyVerifiedPayment({
    providerId: PROVIDER,
    event: callback(bobOrder.orderId, bobOrder.reference!),
    source: "callback",
  });
  const bobAfter = await ensureSubscription(bob.id);
  const aliceAfter = await ensureSubscription(alice.id);
  check("a callback activates only the order's own owner", bobAfter.unlimited === true);
  check("and does not disturb the other account", aliceAfter.tokensUsed === 7_500_000);

  const wrongProvider = await makeOrder(bob.id);
  const providerMismatch = await applyVerifiedPayment({
    providerId: "some-other-gateway",
    event: callback(wrongProvider.orderId, wrongProvider.reference!),
    source: "callback",
  });
  check(
    "a callback from an unexpected provider is rejected",
    providerMismatch.reason === "provider_mismatch",
    JSON.stringify(providerMismatch),
  );
}

async function cleanup() {
  // The unknown-order rejection is audited with `userId: null` — there is no owner to attribute a
  // callback for an order we never wrote — so it cannot be cleaned up by id like everything else.
  // Scoped to this run's window and to unattributed payment rows only.
  await prisma.auditLog.deleteMany({
    where: { userId: null, action: { startsWith: "payment." }, createdAt: { gte: startedAt } },
  });
  if (createdUserIds.length === 0) return;
  // Scoped strictly to the ids this run created — never a broad delete on the test domain.
  await prisma.auditLog.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.payment.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.subscription.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  console.log(`\nRemoved ${createdUserIds.length} verification account(s) and their rows.`);
}

main()
  .catch((error) => {
    failed += 1;
    console.error("\nUnexpected error:", error);
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("Cleanup failed:", error));
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
