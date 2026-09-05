/**
 * The crypto payment rejection matrix.
 *
 * `evaluateCryptoTransaction` is the whole decision surface of the on-chain rail: every reason a
 * pasted hash is accepted, refused or retried is decided here, from an observation of the chain
 * and an expectation built from server configuration. Because it is pure, the entire matrix the
 * specification asks for — items 1–9 and 13–14 — is assertable without a node, a database or a
 * request.
 *
 * The two properties worth stating explicitly, because they are what the tests below are really
 * protecting:
 *
 *   - **`wait` is never `reject`.** A hash a node has not indexed, a transaction still in the
 *     mempool, and a transfer short of confirmations are all retryable. A lagging RPC endpoint
 *     must not be able to permanently burn a real payment.
 *   - **nothing in `ObservedTransaction` can come from a request.** The "fake frontend" cases
 *     below are expressed the only way they can be: by handing the evaluator an observation that
 *     lies in the payer's favour and showing that the *expectation* — which is server
 *     configuration — still refuses it.
 */
import { describe, expect, it } from "vitest";
import {
  CRYPTO_MESSAGES,
  cryptoMessageForReason,
  evaluateCryptoTransaction,
  isTerminalCryptoReason,
  type CryptoExpectation,
} from "@/lib/payments/crypto/rules";
import type { ObservedTransaction } from "@/lib/payments/crypto/types";

const CHAIN_ID = 8453;
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-08-26T12:00:00.000Z");
const MINED = new Date("2026-08-26T11:59:00.000Z");

const expected: CryptoExpectation = {
  chainId: CHAIN_ID,
  recipient: RECIPIENT,
  // $0.50 of a 6-decimal stablecoin. A fixed integer, so no market rate is ever consulted.
  requiredBaseUnits: "500000",
  minConfirmations: 3,
  maxAgeMs: 24 * 60 * 60 * 1000,
};

/** A transfer that satisfies every rule. Each test below breaks exactly one thing. */
function paid(overrides: Partial<ObservedTransaction> = {}): ObservedTransaction {
  return {
    txHash: `0x${"ab".repeat(32)}`,
    found: true,
    chainId: CHAIN_ID,
    txChainId: CHAIN_ID,
    mined: true,
    succeeded: true,
    blockNumber: "20000000",
    confirmations: 6,
    minedAt: MINED,
    receivedBaseUnits: "500000",
    sender: "0x2222222222222222222222222222222222222222",
    assetMovedElsewhere: false,
    otherAssetReceived: false,
    ...overrides,
  };
}

function decide(observed: ObservedTransaction, now = NOW) {
  return evaluateCryptoTransaction({ observed, expected, now });
}

describe("the happy path", () => {
  it("activates an exact-amount, confirmed, in-window transfer", () => {
    expect(decide(paid())).toEqual({
      action: "activate",
      reason: "paid",
      message: CRYPTO_MESSAGES.confirmed,
    });
  });

  it("activates an overpayment — more than $0.50 still satisfies at least $0.50", () => {
    expect(decide(paid({ receivedBaseUnits: "5000000" })).action).toBe("activate");
  });

  it("activates when the block timestamp could not be read at all", () => {
    // `minedAt: null` means the header read failed. The age check is hardening, not a gate:
    // a transport hiccup must not fail an otherwise valid payment.
    expect(decide(paid({ minedAt: null })).action).toBe("activate");
  });

  it("activates at exactly the minimum confirmation count", () => {
    expect(decide(paid({ confirmations: 3 })).action).toBe("activate");
  });
});

describe("retryable outcomes — a lagging node must never burn a payment", () => {
  it("waits, not rejects, for a hash the node has never seen (spec item 3)", () => {
    // Indistinguishable from a hash that does not exist. Being wrong in the safe direction
    // costs the payer a retry; being wrong the other way costs them the payment.
    const decision = decide(paid({ found: false, mined: false, succeeded: null }));
    expect(decision).toEqual({
      action: "wait",
      reason: "not_found",
      message: CRYPTO_MESSAGES.unverifiable,
    });
  });

  it("waits for a transaction still in the mempool (spec item 8)", () => {
    const decision = decide(
      paid({ mined: false, succeeded: null, blockNumber: null, confirmations: 0, minedAt: null }),
    );
    expect(decision).toEqual({
      action: "wait",
      reason: "unmined",
      message: CRYPTO_MESSAGES.notConfirmed,
    });
  });

  it("waits below the confirmation threshold", () => {
    const decision = decide(paid({ confirmations: 2 }));
    expect(decision).toEqual({
      action: "wait",
      reason: "unconfirmed",
      message: CRYPTO_MESSAGES.notConfirmed,
    });
  });

  it("marks none of the retryable reasons terminal", () => {
    for (const reason of ["not_found", "unmined", "unconfirmed"]) {
      expect(isTerminalCryptoReason(reason), reason).toBe(false);
    }
  });
});

describe("terminal rejections", () => {
  it("rejects a transaction that declares a different chain id (spec item 5)", () => {
    expect(decide(paid({ txChainId: 1 }))).toEqual({
      action: "reject",
      reason: "wrong_network",
      message: CRYPTO_MESSAGES.wrongNetwork,
    });
  });

  it("rejects a reverted transaction, however convincing the hash (spec item 9)", () => {
    expect(decide(paid({ succeeded: false }))).toEqual({
      action: "reject",
      reason: "reverted",
      message: CRYPTO_MESSAGES.unverifiable,
    });
  });

  it("rejects a transfer of the right token to the wrong address (spec item 4)", () => {
    // The configured token moved, but not to us. `received` is zero and nothing else arrived.
    expect(
      decide(paid({ receivedBaseUnits: "0", sender: null, assetMovedElsewhere: true })),
    ).toEqual({
      action: "reject",
      reason: "wrong_recipient",
      message: CRYPTO_MESSAGES.wrongRecipient,
    });
  });

  it("rejects a transfer of the wrong token to the right address (spec item 6)", () => {
    // Something reached us, just not the asset we accept — the payer's next action differs
    // from the wrong-address case, so the message does too.
    expect(decide(paid({ receivedBaseUnits: "0", otherAssetReceived: true }))).toEqual({
      action: "reject",
      reason: "wrong_asset",
      message: CRYPTO_MESSAGES.wrongAsset,
    });
  });

  it("rejects one base unit short of the price (spec item 7)", () => {
    expect(decide(paid({ receivedBaseUnits: "499999" }))).toEqual({
      action: "reject",
      reason: "insufficient_amount",
      message: CRYPTO_MESSAGES.insufficient,
    });
  });

  it("rejects a transfer older than the payment window", () => {
    // Without this, any historical transfer to the receiving address — dust, an abandoned
    // payment — is claimable by whoever finds it in the explorer first.
    const stale = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    expect(decide(paid({ minedAt: stale }))).toEqual({
      action: "reject",
      reason: "too_old",
      message: CRYPTO_MESSAGES.tooOld,
    });
  });

  it("reports an RPC serving the wrong chain as unverifiable, not as the payer's fault", () => {
    // An operator error. The audit log gets the real reason; the payer gets the generic string.
    expect(decide(paid({ chainId: 1, txChainId: 1 }))).toEqual({
      action: "reject",
      reason: "rpc_chain_mismatch",
      message: CRYPTO_MESSAGES.unverifiable,
    });
  });

  it("marks every terminal reason terminal", () => {
    for (const reason of [
      "wrong_network",
      "reverted",
      "wrong_asset",
      "wrong_recipient",
      "insufficient_amount",
      "too_old",
      "rpc_chain_mismatch",
    ]) {
      expect(isTerminalCryptoReason(reason), reason).toBe(true);
    }
  });
});

describe("the order the rules are applied in", () => {
  it("reports a genuine payer mistake before staleness", () => {
    // A transfer that is both short and stale must say "insufficient": that is the part the
    // payer can act on. The age check is deliberately last for exactly this reason.
    const stale = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
    expect(decide(paid({ receivedBaseUnits: "1", minedAt: stale })).reason).toBe(
      "insufficient_amount",
    );
  });

  it("reports an unconfirmed transaction before inspecting the amount", () => {
    // The amount is read from receipt logs, which are not final until the block is. Judging the
    // amount first would let a re-orged log produce a terminal rejection.
    expect(decide(paid({ confirmations: 0, receivedBaseUnits: "0" })).reason).toBe("unconfirmed");
  });

  it("stops at an RPC chain mismatch before interpreting anything else the node said", () => {
    expect(decide(paid({ chainId: 1, receivedBaseUnits: "0", succeeded: false })).reason).toBe(
      "rpc_chain_mismatch",
    );
  });
});

describe("configuration knobs", () => {
  it("skips the age check entirely when the window is disabled", () => {
    // CRYPTO_PAYMENT_MAX_AGE_HOURS=0. An operator who wants historical transfers claimable can
    // have that, explicitly.
    const decision = evaluateCryptoTransaction({
      observed: paid({ minedAt: new Date("2024-01-01T00:00:00.000Z") }),
      expected: { ...expected, maxAgeMs: 0 },
      now: NOW,
    });
    expect(decision.action).toBe("activate");
  });

  it("activates on a zero-confirmation configuration without waiting", () => {
    const decision = evaluateCryptoTransaction({
      observed: paid({ confirmations: 0 }),
      expected: { ...expected, minConfirmations: 0 },
      now: NOW,
    });
    expect(decision.action).toBe("activate");
  });

  it("tolerates a transaction that declares no chain id of its own (pre-EIP-155)", () => {
    expect(decide(paid({ txChainId: null })).action).toBe("activate");
  });
});

describe("nothing a client could send changes the verdict (spec items 13 and 14)", () => {
  it("ignores any claimed amount — only the observed transfer counts (item 13)", () => {
    // There is no parameter here for a client-supplied amount, which is the structural half of
    // the answer. The behavioural half: hand the evaluator an observation that *lies* in the
    // payer's favour and the expectation still refuses it, because that side is configuration.
    const lying = paid({ receivedBaseUnits: "1" });
    expect(decide(lying)).toEqual({
      action: "reject",
      reason: "insufficient_amount",
      message: CRYPTO_MESSAGES.insufficient,
    });
  });

  it("ignores any claimed recipient — a zero transfer to us is refused whatever else moved (item 14)", () => {
    // `receivedBaseUnits` is summed from `Transfer` logs whose `to` matches the *configured*
    // address. A payer asserting the address was right cannot make that sum non-zero.
    for (const observed of [
      paid({ receivedBaseUnits: "0", assetMovedElsewhere: true }),
      paid({ receivedBaseUnits: "0", sender: null }),
      paid({ receivedBaseUnits: "" }),
    ]) {
      expect(decide(observed).action).toBe("reject");
    }
  });

  it("cannot be made to accept a transfer on another chain by any other field", () => {
    expect(
      decide(paid({ txChainId: 1, confirmations: 999, receivedBaseUnits: "999999999" })).reason,
    ).toBe("wrong_network");
  });

  it("never returns a message outside the fixed payer-facing vocabulary", () => {
    // The guarantee behind "jangan bocorkan detail internal RPC/API": every branch returns one
    // of nine constants, and every reason is a machine token, not a node response.
    const vocabulary = new Set<string>(Object.values(CRYPTO_MESSAGES));
    const cases = [
      paid(),
      paid({ found: false }),
      paid({ txChainId: 1 }),
      paid({ mined: false }),
      paid({ succeeded: false }),
      paid({ confirmations: 0 }),
      paid({ receivedBaseUnits: "0" }),
      paid({ receivedBaseUnits: "0", otherAssetReceived: true }),
      paid({ receivedBaseUnits: "1" }),
      paid({ minedAt: new Date(0) }),
      paid({ chainId: 1 }),
    ];
    for (const observed of cases) {
      const decision = decide(observed);
      expect(vocabulary.has(decision.message), decision.message).toBe(true);
      expect(decision.reason, decision.reason).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("cryptoMessageForReason", () => {
  it("reconstructs the payer-facing string for a reason persisted earlier", () => {
    // A terminal row is never re-verified, so a resubmitted hash gets its message from
    // `Payment.failureReason` rather than from a fresh chain read.
    const pairs: Array<[string, string]> = [
      ["wrong_network", CRYPTO_MESSAGES.wrongNetwork],
      ["wrong_recipient", CRYPTO_MESSAGES.wrongRecipient],
      ["wrong_asset", CRYPTO_MESSAGES.wrongAsset],
      ["insufficient_amount", CRYPTO_MESSAGES.insufficient],
      ["too_old", CRYPTO_MESSAGES.tooOld],
      ["unmined", CRYPTO_MESSAGES.notConfirmed],
      ["unconfirmed", CRYPTO_MESSAGES.notConfirmed],
      ["tx_claimed_by_other", CRYPTO_MESSAGES.alreadyUsed],
      ["reverted", CRYPTO_MESSAGES.unverifiable],
      ["rpc_chain_mismatch", CRYPTO_MESSAGES.unverifiable],
    ];
    for (const [reason, message] of pairs) {
      expect(cryptoMessageForReason(reason), reason).toBe(message);
    }
  });

  it("agrees with the evaluator on every reason the evaluator can produce", () => {
    // The two functions must not drift: whatever `evaluateCryptoTransaction` chose to show a
    // payer live must be what a reload shows from the stored reason.
    const observations = [
      paid({ txChainId: 1 }),
      paid({ receivedBaseUnits: "0" }),
      paid({ receivedBaseUnits: "0", otherAssetReceived: true }),
      paid({ receivedBaseUnits: "499999" }),
      paid({ minedAt: new Date(0) }),
      paid({ mined: false }),
      paid({ confirmations: 0 }),
      paid({ succeeded: false }),
    ];
    for (const observed of observations) {
      const decision = decide(observed);
      expect(cryptoMessageForReason(decision.reason), decision.reason).toBe(decision.message);
    }
  });

  it("falls back to the generic string so a raw machine token can never reach the UI", () => {
    for (const unknown of [null, undefined, "", "provider_unavailable", "something_added_later"]) {
      expect(cryptoMessageForReason(unknown), String(unknown)).toBe(CRYPTO_MESSAGES.unverifiable);
    }
  });
});
