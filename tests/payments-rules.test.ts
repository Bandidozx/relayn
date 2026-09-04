/**
 * Callback decision rules — the gate between "a provider said something" and "an account is
 * upgraded forever". Every branch the approved brief specified is asserted here, because this
 * is the only place the decision is made and it is pure enough to test exhaustively.
 *
 * What is deliberately covered:
 *   - an unknown order grants nothing (a forged callback lands here);
 *   - a callback for another provider's order grants nothing;
 *   - a reference that does not match the one bound at checkout grants nothing, so a callback
 *     cannot be replayed against a different user's order;
 *   - only the exact server-decided amount activates;
 *   - only `paid` activates; UNPAID/FAILED/EXPIRED/REFUND never do;
 *   - a second callback for a settled order changes nothing (idempotency);
 *   - a later `refund` does not revoke permanent access.
 */
import { describe, expect, it } from "vitest";
import { UNLIMITED_PRICE_IDR } from "@/lib/plans";
import { evaluateCallback, isTerminalFailure, type PaymentSnapshot } from "@/lib/payments/rules";
import type { CallbackEvent, PaymentStatus } from "@/lib/payments/types";

const PROVIDER = "tripay";
const ORDER = "RLYN-UNL-abc123";
const REFERENCE = "DEV-T1234567890";

function snapshot(over: Partial<PaymentSnapshot> = {}): PaymentSnapshot {
  return {
    orderId: ORDER,
    provider: PROVIDER,
    reference: REFERENCE,
    amount: UNLIMITED_PRICE_IDR,
    status: "pending",
    ...over,
  };
}

function event(over: Partial<CallbackEvent> = {}): CallbackEvent {
  return {
    orderId: ORDER,
    reference: REFERENCE,
    status: "paid",
    amountIdr: UNLIMITED_PRICE_IDR,
    grossAmountIdr: UNLIMITED_PRICE_IDR,
    paidAt: new Date("2026-08-25T10:00:00Z"),
    method: "QRIS",
    ...over,
  };
}

function decide(payment: PaymentSnapshot | null, ev: CallbackEvent = event()) {
  return evaluateCallback({ payment, event: ev, providerId: PROVIDER });
}

describe("evaluateCallback — the happy path", () => {
  it("activates a pending order paid for the exact price", () => {
    expect(decide(snapshot())).toEqual({ action: "activate", reason: "paid" });
  });

  it("accepts a callback for an order with no reference bound yet", () => {
    // The provider can call back before our create response has been persisted. `merchant_ref`
    // is ours and unique, so the order is still identified; the reference check simply has
    // nothing to compare against.
    expect(decide(snapshot({ reference: null })).action).toBe("activate");
  });
});

describe("evaluateCallback — rejects what contradicts our records", () => {
  it("grants nothing when no order matches", () => {
    // A signed callback for an order this deployment never created, e.g. a TriPay account
    // shared with another app.
    expect(decide(null)).toEqual({ action: "reject", reason: "unknown_order" });
  });

  it("grants nothing when the order belongs to a different provider", () => {
    expect(decide(snapshot({ provider: "midtrans" }))).toEqual({
      action: "reject",
      reason: "provider_mismatch",
    });
  });

  it("grants nothing when the reference does not match the one bound at checkout", () => {
    // The replay-onto-another-order case: correct signature, correct merchant_ref, wrong
    // transaction. Cannot activate anything.
    expect(decide(snapshot(), event({ reference: "DEV-SOMEONE-ELSE" }))).toEqual({
      action: "reject",
      reason: "reference_mismatch",
    });
  });

  it("grants nothing when the amount is not exactly Rp5.000", () => {
    for (const amountIdr of [0, 1, 4_999, 5_001, 500, 50_000, UNLIMITED_PRICE_IDR - 1]) {
      expect(decide(snapshot(), event({ amountIdr }))).toEqual({
        action: "reject",
        reason: "amount_mismatch",
      });
    }
  });

  it("checks the net order amount, not the gross the payer transferred", () => {
    // With customer-borne fees the payer sends more than the order amount. The order amount
    // is what must match; the gross is recorded only.
    const paidWithFee = event({ amountIdr: UNLIMITED_PRICE_IDR, grossAmountIdr: 5_750 });
    expect(decide(snapshot(), paidWithFee).action).toBe("activate");
  });
});

describe("evaluateCallback — only PAID activates", () => {
  it("ignores a still-unpaid callback", () => {
    expect(decide(snapshot(), event({ status: "pending" }))).toEqual({
      action: "ignore",
      reason: "not_settled_yet",
    });
  });

  it("records a terminal non-paid outcome without granting anything", () => {
    for (const status of ["failed", "expired", "refund"] as const) {
      const decision = decide(snapshot(), event({ status }));
      expect(decision.action).toBe("mark_failed");
      expect(decision.reason).toBe(`provider_status:${status}`);
    }
  });

  it("never returns activate for any status other than paid", () => {
    const statuses: PaymentStatus[] = ["pending", "paid", "failed", "expired", "refund"];
    for (const status of statuses) {
      const decision = decide(snapshot(), event({ status }));
      expect(decision.action === "activate").toBe(status === "paid");
    }
  });
});

describe("evaluateCallback — idempotency", () => {
  it("ignores a repeated callback for an order already paid", () => {
    // TriPay retries three times. The second delivery must not run activation again.
    expect(decide(snapshot({ status: "paid" }))).toEqual({
      action: "ignore",
      reason: "already_settled:paid",
    });
  });

  it("ignores any callback once the order has left pending", () => {
    for (const status of ["paid", "failed", "expired", "refund"]) {
      const decision = decide(snapshot({ status }));
      expect(decision.action).toBe("ignore");
      expect(decision.reason).toBe(`already_settled:${status}`);
    }
  });

  it("does not let a later refund callback revoke permanent access", () => {
    // Business decision, recorded explicitly: paid once, unlimited forever. A refund arriving
    // after activation is audited as an ignored replay, never as a downgrade.
    const decision = decide(snapshot({ status: "paid" }), event({ status: "refund" }));
    expect(decision.action).toBe("ignore");
    expect(decision.action).not.toBe("mark_failed");
  });

  it("settles the amount check before the status check cannot be skipped", () => {
    // A settled order with a wrong amount is still just a replay — the amount branch must not
    // be reachable for a row that is no longer pending.
    expect(decide(snapshot({ status: "paid" }), event({ amountIdr: 1 })).action).toBe("ignore");
  });
});

describe("isTerminalFailure", () => {
  it("is true only for the three statuses mark_failed may write", () => {
    expect(isTerminalFailure("failed")).toBe(true);
    expect(isTerminalFailure("expired")).toBe(true);
    expect(isTerminalFailure("refund")).toBe(true);
    expect(isTerminalFailure("paid")).toBe(false);
    expect(isTerminalFailure("pending")).toBe(false);
  });
});
