/**
 * End-to-end verification of the on-chain unlimited purchase, against the real database.
 *
 * The Vitest suite covers what is pure: the money arithmetic (`tests/payments-crypto-amount`),
 * the rejection matrix (`tests/payments-crypto-rules`) and the RPC adapter against a mocked
 * `fetch` (`tests/payments-crypto-evm`). What none of it can cover is the half of the
 * double-spend defence that only exists as SQL — the UNIQUE index on `Payment.txHash` and the
 * conditional UPDATE that gates activation. Those need real rows, so they are verified here.
 *
 * Run: npx tsx --conditions=react-server scripts/verify-crypto-payments.ts
 *
 * No node is contacted. `submitTransactionHash` takes a `deps` parameter that exists for exactly
 * this purpose, and the stub provider below returns whatever observation each case needs — which
 * is also the point: every fact the decision rests on arrives through that seam, never from a
 * caller, so a scripted observation is a faithful stand-in for a chain read.
 *
 * Every row this creates is removed again in a `finally` block, including on failure. Accounts
 * are named `cryptoverify-<random>@relayn.test` so a crashed run is identifiable and deletable.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import {
  UNLIMITED_PLAN_ID,
  UNLIMITED_PRICE_USD_MICRO,
  UNLIMITED_TOKEN_ALLOCATION,
  planSatisfies,
} from "../src/lib/plans";
import { CRYPTO_MESSAGES, type CryptoExpectation } from "../src/lib/payments/crypto/rules";
import { CryptoProviderError } from "../src/lib/payments/crypto/types";
import type {
  CryptoPaymentProvider,
  ObservedTransaction,
  PaymentInstructions,
} from "../src/lib/payments/crypto/types";
import {
  CRYPTO_PROVIDER,
  latestCryptoPaymentForUser,
  submitTransactionHash,
  toCryptoView,
} from "../src/server/services/crypto-payment-service";
import { ensureSubscription, quotaFrom, recordUsage } from "../src/lib/usage/accounting";
import { describeQuota } from "../src/lib/usage/quota-display";

const CHAIN_ID = 8453;
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const OUTSIDER = "0x3333333333333333333333333333333333333333";

/** Server configuration, exactly as `evmExpectation()` would build it for Base + USDC. */
const EXPECTATION: CryptoExpectation = {
  chainId: CHAIN_ID,
  recipient: RECIPIENT,
  requiredBaseUnits: "500000", // $0.50 of a 6-decimal stablecoin, as a fixed integer
  minConfirmations: 3,
  maxAgeMs: 24 * 60 * 60 * 1000,
};

const INSTRUCTIONS: PaymentInstructions = {
  network: "base",
  networkLabel: "Base",
  chainId: CHAIN_ID,
  asset: "USDC",
  assetAddress: TOKEN,
  assetDecimals: 6,
  address: RECIPIENT,
  amount: "0.50",
  amountBaseUnits: "500000",
  priceUsd: "$0.50",
  minConfirmations: 3,
  explorerUrl: "https://basescan.org",
};

/** A transfer that satisfies every rule. Each case below breaks exactly one thing. */
function observation(txHash: string, over: Partial<ObservedTransaction> = {}): ObservedTransaction {
  return {
    txHash,
    found: true,
    chainId: CHAIN_ID,
    txChainId: CHAIN_ID,
    mined: true,
    succeeded: true,
    blockNumber: "20000000",
    confirmations: 6,
    minedAt: new Date(Date.now() - 60_000),
    receivedBaseUnits: "500000",
    sender: PAYER,
    assetMovedElsewhere: false,
    otherAssetReceived: false,
    ...over,
  };
}

type Script = (txHash: string) => ObservedTransaction | Promise<ObservedTransaction>;

/** What the "chain" says next. Reassigned per case, never read from a request. */
let script: Script = (txHash) => observation(txHash);

const provider: CryptoPaymentProvider = {
  id: "evm-erc20",
  label: "Base · USDC",
  credentialEnvVars: ["CRYPTO_PAYMENT_NETWORK"],
  isConfigured: () => true,
  getPaymentInstructions: () => INSTRUCTIONS,
  normalizePayment: (baseUnits) => {
    const value = BigInt(baseUnits);
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return fraction === "" ? (value / 1_000_000n).toString() : `${value / 1_000_000n}.${fraction}`;
  },
  verifyTransaction: async (txHash) => script(txHash),
};

const deps = { provider, expectation: EXPECTATION };

function chainSays(next: Script): void {
  script = next;
}

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
      email: `cryptoverify-${tag}-${suffix}@relayn.test`,
      name: `Crypto Verify ${tag}`,
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

/** A fresh, well-formed hash. Distinct per case so nothing collides accidentally. */
function newHash(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

async function rowFor(txHash: string) {
  return prisma.payment.findUnique({ where: { txHash } });
}

/** True when a `payment.rejected` row exists for this order carrying this reason. */
async function auditedRejection(userId: string, orderId: string, reason: string) {
  const rows = await prisma.auditLog.findMany({
    where: { userId, action: "payment.rejected", targetId: orderId },
  });
  return rows.some((audit) => {
    if (!audit.metadata) return false;
    try {
      return (JSON.parse(audit.metadata) as { reason?: unknown }).reason === reason;
    } catch {
      return false;
    }
  });
}


function submit(userId: string, txHash: unknown, email?: string) {
  return submitTransactionHash({ userId, rawTxHash: txHash, actorEmail: email, deps });
}

async function main() {
  console.log(`\nCrypto payment verification (suffix ${suffix})\n`);

  // ── 16. An account that has not paid stays Free ────────────────────────────────────────
  console.log("An unpaid account");
  const alice = await makeUser("alice");
  let sub = await ensureSubscription(alice.id);
  check("starts on the Free plan", sub.plan === "free", `plan was ${sub.plan}`);
  check("is not unlimited", sub.unlimited === false);
  check("has no on-chain payment to show", (await latestCryptoPaymentForUser(alice.id)) === null);

  // ── 2. A hash that is not a hash never reaches the chain or the database ────────────────
  console.log("\nMalformed input");
  let rpcCalls = 0;
  chainSays((txHash) => {
    rpcCalls += 1;
    return observation(txHash);
  });
  for (const bad of ["", "0x", "not-a-hash", `0x${"ab".repeat(31)}`, `0x${"zz".repeat(32)}`, 42]) {
    const result = await submit(alice.id, bad);
    check(
      `rejects ${JSON.stringify(bad)} without a row or a chain read`,
      result.status === "rejected" && result.payment === null,
      JSON.stringify(result),
    );
  }
  check("no RPC read was attempted for any of them", rpcCalls === 0, `calls: ${rpcCalls}`);
  check(
    "and no payment row was written",
    (await prisma.payment.count({ where: { userId: alice.id } })) === 0,
  );

  // ── 3 / 8. Retryable outcomes keep the hash claimed and the row pending ─────────────────
  console.log("\nRetryable outcomes");
  const unknownHash = newHash();
  chainSays((txHash) => observation(txHash, { found: false, mined: false, succeeded: null }));
  const unknown = await submit(alice.id, unknownHash);
  check(
    "a hash no node has indexed is pending, not rejected",
    unknown.status === "pending" && unknown.activated === false,
    JSON.stringify(unknown),
  );
  let row = await rowFor(unknownHash);
  check("the row stays pending", row?.status === "pending", `status ${row?.status}`);
  check("with the reason recorded", row?.failureReason === "not_found");
  check("and the payer is told nothing internal", unknown.message === CRYPTO_MESSAGES.unverifiable);

  const mempoolHash = newHash();
  chainSays((txHash) =>
    observation(txHash, { mined: false, succeeded: null, blockNumber: null, confirmations: 0 }),
  );
  const mempool = await submit(alice.id, mempoolHash);
  check("a mempool transaction is pending", mempool.status === "pending");
  check("with the not-confirmed message", mempool.message === CRYPTO_MESSAGES.notConfirmed);

  const unconfirmedHash = newHash();
  chainSays((txHash) => observation(txHash, { confirmations: 1 }));
  const unconfirmed = await submit(alice.id, unconfirmedHash);
  check("a transfer short of confirmations is pending", unconfirmed.status === "pending");
  row = await rowFor(unconfirmedHash);
  check("and the observed confirmation count is stored", row?.confirmations === 1);
  check(
    "an unconfirmed row is never marked failed, so the hash remains usable",
    row?.status === "pending",
    `status ${row?.status}`,
  );

  // ── 4 / 5 / 6 / 7 / 9. Terminal rejections close the row and grant nothing ───────────────
  console.log("\nTerminal rejections");
  const terminal: Array<[string, Partial<ObservedTransaction>, string, string]> = [
    ["a transfer to the wrong address", { receivedBaseUnits: "0", assetMovedElsewhere: true }, "wrong_recipient", CRYPTO_MESSAGES.wrongRecipient],
    ["a transfer of the wrong asset", { receivedBaseUnits: "0", otherAssetReceived: true }, "wrong_asset", CRYPTO_MESSAGES.wrongAsset],
    ["a transaction on another chain", { txChainId: 1 }, "wrong_network", CRYPTO_MESSAGES.wrongNetwork],
    ["one base unit short of the price", { receivedBaseUnits: "99999" }, "insufficient_amount", CRYPTO_MESSAGES.insufficient],
    ["a reverted transaction", { succeeded: false }, "reverted", CRYPTO_MESSAGES.unverifiable],
    ["a transfer older than the window", { minedAt: new Date(Date.now() - 48 * 3_600_000) }, "too_old", CRYPTO_MESSAGES.tooOld],
  ];

  for (const [label, over, reason, message] of terminal) {
    const hash = newHash();
    chainSays((txHash) => observation(txHash, { sender: OUTSIDER, ...over }));
    const result = await submit(alice.id, hash, alice.email);
    const stored = await rowFor(hash);
    check(
      `${label} is rejected as ${reason}`,
      result.status === "rejected" && stored?.failureReason === reason,
      `${result.status} / ${stored?.failureReason}`,
    );
    check(`  and the payer sees the right message`, result.message === message, result.message);
    check(`  and the row is closed as failed`, stored?.status === "failed", `status ${stored?.status}`);
    check(`  and it is audited`, await auditedRejection(alice.id, stored?.orderId ?? "", reason));
    // Re-submitting a terminal hash must not spend another chain read.
    let reread = 0;
    chainSays((txHash) => {
      reread += 1;
      return observation(txHash);
    });
    const again = await submit(alice.id, hash);
    check(
      `  and re-submitting it is answered from the stored reason alone`,
      again.status === "rejected" && again.message === message && reread === 0,
      `${again.message} / rpc reads: ${reread}`,
    );
  }

  sub = await ensureSubscription(alice.id);
  check("none of it granted anything", sub.unlimited === false && sub.plan === "free");

  // ── 1 / 13 / 14. A valid transfer activates permanent unlimited ─────────────────────────
  console.log("\nA verified $0.50 transfer");
  // The same hash that was one confirmation short above. Nothing about the row changed; the
  // chain simply moved on — which is the case a terminal rejection would have destroyed.
  chainSays((txHash) => observation(txHash, { confirmations: 4 }));
  const activation = await submit(alice.id, unconfirmedHash, alice.email);
  check(
    "activates on the first sufficient observation",
    activation.activated === true && activation.status === "confirmed",
    JSON.stringify(activation),
  );
  check("and reports it in the fixed vocabulary", activation.message === CRYPTO_MESSAGES.confirmed);

  sub = await ensureSubscription(alice.id);
  check("sets plan = unlimited", sub.plan === UNLIMITED_PLAN_ID, `plan is ${sub.plan}`);
  check("sets status = active", sub.status === "active");
  check("sets unlimited = true", sub.unlimited === true);
  check("leaves planExpiresAt null — permanent by construction", sub.planExpiresAt === null);
  check("stores the sentinel allocation", sub.tokenAllocation === UNLIMITED_TOKEN_ALLOCATION);

  const paidRow = await rowFor(unconfirmedHash);
  check("marks the row paid", paidRow?.status === "paid", `status ${paidRow?.status}`);
  check("clears the earlier failure reason", paidRow?.failureReason === null);
  check("records verifiedAt and appliedAt", !!paidRow?.verifiedAt && !!paidRow?.appliedAt);
  check(
    "prices it from the plan catalogue, not from the chain",
    paidRow?.paidAmount === UNLIMITED_PRICE_USD_MICRO,
    `paidAmount ${paidRow?.paidAmount}`,
  );
  check("stores the observed transfer as base units", paidRow?.amountRaw === "500000");
  check(
    "stores the required amount from server configuration (item 13)",
    paidRow?.amountRequired === EXPECTATION.requiredBaseUnits,
  );
  check(
    "stores the recipient from server configuration, never from a request (item 14)",
    paidRow?.recipient === RECIPIENT,
  );
  check("stores the sender the node reported", paidRow?.sender === PAYER);
  check("stores the confirmation count observed at activation", paidRow?.confirmations === 4);
  const firstAppliedAt = paidRow?.appliedAt?.getTime() ?? 0;

  const view = paidRow ? toCryptoView(paidRow) : null;
  check("the payer's own view shows it applied", view?.applied === true && view?.status === "paid");
  check("with the amount in whole units", view?.amount === "0.1", String(view?.amount));
  check(
    "and carries no owner id or internal column",
    view !== null && !("userId" in view) && !("id" in view),
    view ? Object.keys(view).join(", ") : "null",
  );
  // `latestCryptoPaymentForUser` means newest, not best: this account's newest row is one of the
  // rejections above, because the activated hash was submitted before them. The card reads
  // `subscription.unlimited` for the access state and only shows a receipt line when the latest
  // row is paid, so a stale failed row omits the receipt rather than contradicting the account.
  const latest = await latestCryptoPaymentForUser(alice.id);
  check(
    "the newest row is the one surfaced, whatever its outcome",
    latest !== null && latest.orderId !== view?.orderId && latest.status === "failed",
    JSON.stringify([latest?.status, latest?.orderId, view?.orderId]),
  );

  const verifiedAudits = await prisma.auditLog.count({
    where: { userId: alice.id, action: "payment.verified", targetId: paidRow?.orderId ?? "" },
  });
  const activatedAudits = await prisma.auditLog.count({
    where: { userId: alice.id, action: "payment.activated" },
  });
  check("the verification is audited once", verifiedAudits === 1, `count ${verifiedAudits}`);
  check("the activation is audited once", activatedAudits === 1, `count ${activatedAudits}`);
  const verifiedAudit = await prisma.auditLog.findFirst({
    where: { userId: alice.id, action: "payment.verified" },
  });
  const verifiedMeta = JSON.parse(verifiedAudit?.metadata ?? "{}") as Record<string, unknown>;
  check(
    "the audit trail records the chain-attested figures",
    verifiedMeta.txHash === unconfirmedHash &&
      verifiedMeta.receivedBaseUnits === "500000" &&
      verifiedMeta.requiredBaseUnits === "500000" &&
      verifiedMeta.recipient === RECIPIENT &&
      verifiedMeta.sender === PAYER,
    verifiedAudit?.metadata ?? "no metadata",
  );
  check(
    "and no RPC url or node response text",
    !/http|rpc_url|jsonrpc/i.test(verifiedAudit?.metadata ?? ""),
    verifiedAudit?.metadata ?? "",
  );

  // ── 15. The access is permanent, and a second hash cannot be spent on it ────────────────
  console.log("\nPermanence");
  chainSays((txHash) => observation(txHash));
  await expectRejection(
    "a paid account cannot submit another hash",
    () => submit(alice.id, newHash(), alice.email),
    /already has permanent unlimited access/i,
  );
  check(
    "and no second row was written for it",
    (await prisma.payment.count({ where: { userId: alice.id, status: "paid" } })) === 1,
  );

  await prisma.subscription.update({
    where: { userId: alice.id },
    // A renewal date well in the past is exactly what triggers the metered monthly rollover.
    data: { renewalDate: new Date("2020-01-01T00:00:00Z"), tokensUsed: 7_500_000 },
  });
  sub = await ensureSubscription(alice.id);
  check("ensureSubscription does not downgrade an unlimited row", sub.unlimited === true);
  check("the plan is untouched", sub.plan === UNLIMITED_PLAN_ID, `plan is ${sub.plan}`);
  check("planExpiresAt is still null", sub.planExpiresAt === null);
  check("the lifetime token total is not zeroed", sub.tokensUsed === 7_500_000);

  const subscriptionRoute = readFileSync(
    new URL("../src/app/api/subscription/route.ts", import.meta.url),
    "utf8",
  );
  check(
    "/api/subscription has no PATCH — nothing can name a plan in a request body",
    /export const GET\b/.test(subscriptionRoute) &&
      !["POST", "PATCH", "PUT", "DELETE"].some((verb) =>
        subscriptionRoute.includes(`export const ${verb}`),
      ),
  );
  check(
    "and the service behind it exports no plan mutator",
    !/export (async )?function changePlan\b/.test(
      readFileSync(new URL("../src/server/services/subscription-service.ts", import.meta.url), "utf8"),
    ),
  );
  sub = await ensureSubscription(alice.id);
  check("the account is still unlimited after both checks", sub.unlimited === true);

  // ── 17. Usage accounting still works, and never exhausts ────────────────────────────────
  console.log("\nUsage accounting on an unlimited account");
  await recordUsage({
    userId: alice.id,
    apiKeyId: null,
    modelId: "gpt-4o-mini",
    provider: "verify",
    endpoint: "/v1/chat/completions",
    requestId: `cryptoverify-${suffix}`,
    usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
    latencyMs: 42,
    status: "success",
    httpStatus: 200,
    costMicroUsd: 137,
    streamed: false,
  });
  sub = await ensureSubscription(alice.id);
  check("usage is still metered for the record", sub.tokensUsed === 7_501_500, `used ${sub.tokensUsed}`);
  let quota = quotaFrom(sub);
  check("quotaFrom reports unlimited", quota.unlimited === true);
  check("and never reports exhaustion", quota.exhausted === false);
  const display = describeQuota(quota);
  check(
    "the UI descriptor says Unlimited with no bar and no renewal",
    display.primary === "Unlimited" && display.percent === null && display.renewalLabel === null,
    JSON.stringify(display),
  );

  await prisma.subscription.update({
    where: { userId: alice.id },
    // Past the sentinel allocation, which is where a naive `remaining <= 0` would lock the account.
    data: { tokensUsed: UNLIMITED_TOKEN_ALLOCATION + 1 },
  });
  quota = quotaFrom(await ensureSubscription(alice.id));
  check("still not exhausted beyond the sentinel allocation", quota.exhausted === false);

  const models = await prisma.aiModel.findMany({ select: { modelId: true, minPlan: true } });
  const blocked = models.filter((model) => !planSatisfies(UNLIMITED_PLAN_ID, model.minPlan));
  check(
    `unlimited reaches all ${models.length} catalogue models`,
    blocked.length === 0,
    blocked.map((model) => model.modelId).join(", "),
  );

  // ── 10. The same hash submitted twice at once activates exactly once ─────────────────────
  console.log("\nOne hash, one activation");
  const carol = await makeUser("carol");
  const raceHash = newHash();
  chainSays((txHash) => observation(txHash));
  // Sequential re-submission is refused earlier, by the unlimited guard, so the conditional
  // UPDATE gate can only be exercised concurrently: both calls read a Free subscription, both
  // claim the same row, and both reach the activation transaction.
  const doubleClick = await Promise.all([
    submit(carol.id, raceHash, carol.email),
    submit(carol.id, raceHash, carol.email),
  ]);
  check(
    "exactly one of two simultaneous submissions activates",
    doubleClick.filter((result) => result.activated).length === 1,
    JSON.stringify(doubleClick.map((result) => [result.status, result.activated])),
  );
  check(
    "both are answered as confirmed, not as an error",
    doubleClick.every((result) => result.status === "confirmed"),
  );
  const carolRow = await rowFor(raceHash);
  check("only one row exists for the hash", carolRow !== null && carolRow.userId === carol.id);
  check("and appliedAt was written once", carolRow?.appliedAt !== null);
  const carolActivations = await prisma.auditLog.count({
    where: { userId: carol.id, action: "payment.activated" },
  });
  check("activation is audited exactly once", carolActivations === 1, `count ${carolActivations}`);
  const carolSub = await ensureSubscription(carol.id);
  check("the account is unlimited", carolSub.unlimited === true);
  check(
    "and only one payment row was created in total",
    (await prisma.payment.count({ where: { userId: carol.id } })) === 1,
  );
  const carolView = await latestCryptoPaymentForUser(carol.id);
  check(
    "the account's own receipt reads as applied",
    carolView?.status === "paid" && carolView?.applied === true && carolView?.amount === "0.1",
    JSON.stringify(carolView),
  );

  // ── 11. Two accounts, one hash, at the same moment ──────────────────────────────────────
  console.log("\nTwo accounts racing for one hash");
  const dave = await makeUser("dave");
  const erin = await makeUser("erin");
  const contestedHash = newHash();
  chainSays((txHash) => observation(txHash));
  const race = await Promise.all([
    submit(dave.id, contestedHash, dave.email),
    submit(erin.id, contestedHash, erin.email),
  ]);
  const winners = race.filter((result) => result.activated);
  const losers = race.filter((result) => result.status === "already_used");
  check(
    "exactly one account is granted access",
    winners.length === 1,
    JSON.stringify(race.map((result) => [result.status, result.activated])),
  );
  check("the other is told the transaction is already used", losers.length === 1);
  check(
    "and is told nothing else — no row, no figures",
    losers[0]?.payment === null && losers[0]?.message === CRYPTO_MESSAGES.alreadyUsed,
  );
  const contestedRow = await rowFor(contestedHash);
  const owner = contestedRow?.userId === dave.id ? dave : erin;
  const other = owner.id === dave.id ? erin : dave;
  check(
    "the UNIQUE index left exactly one row for the hash",
    (await prisma.payment.count({ where: { txHash: contestedHash } })) === 1,
  );
  const ownerSub = await ensureSubscription(owner.id);
  const otherSub = await ensureSubscription(other.id);
  check("the winner is unlimited", ownerSub.unlimited === true);
  check("the loser stays Free", otherSub.unlimited === false && otherSub.plan === "free");
  check(
    "and the loser has no payment row at all",
    (await prisma.payment.count({ where: { userId: other.id } })) === 0,
  );

  // ── 12. User A cannot use a hash user B has claimed ─────────────────────────────────────
  console.log("\nCross-account refusal");
  const frank = await makeUser("frank");
  let probeReads = 0;
  chainSays((txHash) => {
    probeReads += 1;
    return observation(txHash);
  });
  const stolen = await submit(frank.id, raceHash, frank.email);
  check(
    "a hash paid by another account is refused",
    stolen.status === "already_used" && stolen.activated === false,
    JSON.stringify(stolen),
  );
  check("with the already-used message", stolen.message === CRYPTO_MESSAGES.alreadyUsed);
  check("and no view of someone else's payment", stolen.payment === null);
  check("no chain read is spent on it", probeReads === 0, `reads ${probeReads}`);
  check(
    "the attempt is audited against the attempting account",
    await auditedRejection(frank.id, raceHash, "tx_claimed_by_other"),
  );
  const stolenAudit = await prisma.auditLog.findFirst({
    where: { userId: frank.id, action: "payment.rejected", targetId: raceHash },
  });
  check(
    "and the audit metadata does not name the owning account",
    !(stolenAudit?.metadata ?? "").includes(carol.id),
    stolenAudit?.metadata ?? "no metadata",
  );
  const frankSub = await ensureSubscription(frank.id);
  check("the attempting account stays Free", frankSub.unlimited === false);
  check(
    "and the owner's row is untouched",
    (await rowFor(raceHash))?.userId === carol.id &&
      (await rowFor(raceHash))?.appliedAt?.getTime() === carolRow?.appliedAt?.getTime(),
  );
  check(
    "the losing racer's refusal was audited the same way",
    await auditedRejection(other.id, contestedHash, "tx_claimed_by_other"),
  );

  // ── An unreachable node is an outage, not a verdict ──────────────────────────────────────
  console.log("\nProvider outage");
  const grace = await makeUser("grace");
  const outageHash = newHash();
  chainSays(() => {
    throw new CryptoProviderError("connect ECONNREFUSED 10.0.0.1:8545", "evm-erc20");
  });
  // One `[relayn] crypto verification unavailable:` line on stderr below is expected: the detail
  // goes to the server log precisely because it must not reach the payer.
  const outage = await submit(grace.id, outageHash, grace.email);
  check(
    "an unreachable node leaves the payment pending, not rejected",
    outage.status === "pending" && outage.activated === false,
    JSON.stringify(outage),
  );
  check("the payer gets the generic string", outage.message === CRYPTO_MESSAGES.unverifiable);
  check(
    "and nothing of the transport error",
    !/ECONNREFUSED|10\.0\.0\.1/.test(outage.message),
    outage.message,
  );
  let outageRow = await rowFor(outageHash);
  check("the row stays pending and claimed", outageRow?.status === "pending");
  check("with the outage recorded as the reason", outageRow?.failureReason === "provider_unavailable");
  check(
    "no rejection is audited for an outage",
    (await prisma.auditLog.count({
      where: { userId: grace.id, action: "payment.rejected" },
    })) === 0,
  );

  // The same hash, once the node comes back. This is what "pending, not rejected" has to mean.
  chainSays((txHash) => observation(txHash));
  const recovered = await submit(grace.id, outageHash, grace.email);
  check("retrying the same hash after the outage activates", recovered.activated === true,
    JSON.stringify(recovered));
  outageRow = await rowFor(outageHash);
  check("and the row settles paid with the reason cleared",
    outageRow?.status === "paid" && outageRow?.failureReason === null);

  // ── 16. Accounts that never paid are untouched by any of this ───────────────────────────
  console.log("\nUnpaid accounts are unaffected");
  const helen = await makeUser("helen");
  const helenSub = await ensureSubscription(helen.id);
  check("a fresh account is Free", helenSub.plan === "free" && helenSub.unlimited === false);
  check("with a finite quota", quotaFrom(helenSub).unlimited === false);
  check("and no crypto payment of its own", (await latestCryptoPaymentForUser(helen.id)) === null);
  for (const [name, id] of [
    ["the losing racer", other.id],
    ["the cross-account attempt", frank.id],
  ] as const) {
    const stillFree = await ensureSubscription(id);
    check(`${name} is still Free`, stillFree.unlimited === false && stillFree.plan === "free");
  }

  // Every row this rail wrote is a crypto row: nothing leaked onto the fiat provider.
  const rails = await prisma.payment.groupBy({
    by: ["provider"],
    where: { userId: { in: createdUserIds } },
    _count: { _all: true },
  });
  check(
    "every payment row written here is on the crypto rail",
    rails.length === 1 && rails[0]!.provider === CRYPTO_PROVIDER,
    rails.map((rail) => `${rail.provider}:${rail._count._all}`).join(", "),
  );
}

async function cleanup() {
  if (createdUserIds.length === 0) return;
  // Scoped strictly to the ids this run created — never a broad delete on the test domain.
  await prisma.usageLog.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.payment.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.subscription.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  // Belt and braces: an unattributed payment audit cannot be deleted by id, so sweep this run's
  // own window only.
  await prisma.auditLog.deleteMany({
    where: { userId: null, action: { startsWith: "payment." }, createdAt: { gte: startedAt } },
  });
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
