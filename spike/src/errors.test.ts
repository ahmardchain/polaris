import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyBroadcastError, isIngressFeeRejection } from "./errors.js";

describe("classifyBroadcastError", () => {
  it("detects a base-fee rejection from the RPC details", () => {
    const failure = classifyBroadcastError({
      shortMessage: "Transaction failed",
      details: "max fee per gas less than block base fee: address 0xabc, maxFeePerGas: 1, baseFee: 5000000",
    });
    assert.equal(failure.kind, "below_base_fee");
    assert.equal(isIngressFeeRejection(failure.kind), true);
  });

  it("does not treat a replacement bump failure as a generic underpriced rejection", () => {
    const failure = classifyBroadcastError(
      new Error("replacement transaction underpriced"),
    );
    assert.equal(failure.kind, "replacement_underpriced");
    assert.equal(isIngressFeeRejection(failure.kind), false);
  });

  it("classifies funds, nonce, and duplicates", () => {
    assert.equal(
      classifyBroadcastError(new Error("insufficient funds for gas * price + value")).kind,
      "insufficient_funds",
    );
    assert.equal(classifyBroadcastError(new Error("nonce too low")).kind, "nonce_too_low");
    assert.equal(classifyBroadcastError(new Error("already known")).kind, "already_known");
    assert.equal(classifyBroadcastError(new Error("boom")).kind, "other");
  });
});
