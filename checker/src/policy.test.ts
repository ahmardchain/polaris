import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide, type PolicyInput } from "./policy.js";

const base: PolicyInput = {
  nowMs: 1_000,
  deadlineMs: 100_000,
  requiredConfirmations: 2,
  stuckAfterMs: 24_000,
  rescueBudgetMs: 90_000,
  msPerConfirmation: 15_000,
  alreadyBumped: false,
  replacementMaxFeePerGas: 1_000_034n,
  feeCapWei: 1_000_000_000n,
  observation: { kind: "unsent" },
};

describe("decide", () => {
  it("sends the underpriced payment before doing anything else", () => {
    assert.equal(decide(base).type, "send_underpriced");
  });

  it("waits out the stuck window even when the fee is already below the base fee", () => {
    const decision = decide({
      ...base,
      nowMs: 5_000,
      observation: {
        kind: "pending",
        hash: "0xunder",
        pendingForMs: 5_000,
        maxFeePerGas: 3n,
        baseFee: 21n,
      },
    });
    assert.equal(decision.type, "wait");
  });

  it("bumps a stuck transaction when the rescue still fits before the deadline and under the cap", () => {
    const decision = decide({
      ...base,
      nowMs: 30_000,
      deadlineMs: 200_000,
      observation: {
        kind: "pending",
        hash: "0xunder",
        pendingForMs: 24_000,
        maxFeePerGas: 3n,
        baseFee: 21n,
      },
    });
    assert.equal(decision.type, "bump");
  });

  it("does not bump when the replacement would miss the deadline", () => {
    const decision = decide({
      ...base,
      nowMs: 20_000,
      deadlineMs: 100_000,
      rescueBudgetMs: 90_000,
      observation: {
        kind: "pending",
        hash: "0xunder",
        pendingForMs: 24_000,
        maxFeePerGas: 3n,
        baseFee: 21n,
      },
    });
    assert.deepEqual(decision, { type: "wait" });
  });

  it("does not bump above the fee cap", () => {
    const decision = decide({
      ...base,
      nowMs: 30_000,
      replacementMaxFeePerGas: 2_000_000_000n,
      feeCapWei: 1_000_000_000n,
      observation: {
        kind: "pending",
        hash: "0xunder",
        pendingForMs: 30_000,
        maxFeePerGas: 3n,
        baseFee: 21n,
      },
    });
    assert.equal(decision.type, "wait");
  });

  it("bumps immediately when the underpriced transaction is rejected for its fee", () => {
    const decision = decide({
      ...base,
      observation: { kind: "rejected", feeRelated: true },
    });
    assert.equal(decision.type, "bump");
  });

  it("gives up on a non-fee rejection", () => {
    const decision = decide({
      ...base,
      observation: { kind: "rejected", feeRelated: false },
    });
    assert.deepEqual(decision, { type: "give_up", reason: "broadcast rejected" });
  });

  it("submits proof only after enough confirmations and before the deadline", () => {
    const proved = decide({
      ...base,
      nowMs: 80_000,
      alreadyBumped: true,
      observation: { kind: "mined", hash: "0xrepl", confirmations: 2 },
    });
    assert.deepEqual(proved, { type: "submit_proof", hash: "0xrepl" });

    const early = decide({
      ...base,
      nowMs: 80_000,
      alreadyBumped: true,
      observation: { kind: "mined", hash: "0xrepl", confirmations: 1 },
    });
    assert.equal(early.type, "wait");
  });

  it("does not submit proof after the deadline", () => {
    const decision = decide({
      ...base,
      nowMs: 100_000,
      deadlineMs: 100_000,
      observation: { kind: "mined", hash: "0xrepl", confirmations: 5 },
    });
    assert.deepEqual(decision, { type: "give_up", reason: "deadline passed before proof" });
  });
});
