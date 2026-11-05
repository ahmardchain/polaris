import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress, parseTransaction, serializeTransaction } from "viem";
import { BASE_SEPOLIA_CHAIN_ID, DEFAULT_FEE_CAP_WEI } from "./constants.js";
import { assertSameNonceReplacement, buildPaymentPlan } from "./plan.js";

const TO = "0x000000000000000000000000000000000000dEaD" as const;

describe("buildPaymentPlan", () => {
  it("builds two EIP-1559 payments that share a nonce and differ in fees", () => {
    const plan = buildPaymentPlan({
      nonce: 7,
      baseFee: 5_000_000n,
      feeCapWei: DEFAULT_FEE_CAP_WEI,
      to: TO,
      value: 1n,
    });
    assertSameNonceReplacement(plan);
    assert.equal(plan.underpriced.nonce, 7);
    assert.equal(plan.replacement.nonce, 7);
    assert.equal(plan.underpriced.chainId, BASE_SEPOLIA_CHAIN_ID);
    assert.equal(plan.underpriced.type, "eip1559");
    assert.equal(plan.underpriced.maxFeePerGas, 2_500_000n);
    assert.equal(plan.underpriced.maxPriorityFeePerGas, 1n);
    assert.equal(plan.replacement.maxPriorityFeePerGas, 1_000_000n);
    assert.equal(plan.replacement.maxFeePerGas, 5_000_000n * 2n + 1_000_000n);

    const stuck = parseTransaction(serializeTransaction(plan.underpriced));
    const replacement = parseTransaction(serializeTransaction(plan.replacement));
    assert.equal(stuck.nonce, replacement.nonce);
    assert.equal(stuck.chainId, BASE_SEPOLIA_CHAIN_ID);
    assert.equal(replacement.chainId, BASE_SEPOLIA_CHAIN_ID);
    assert.equal(getAddress(stuck.to!), TO);
    assert.equal(getAddress(replacement.to!), TO);
    assert.equal(stuck.value, 1n);
    assert.ok(replacement.maxFeePerGas! > stuck.maxFeePerGas!);
    assert.ok(stuck.maxFeePerGas! < 5_000_000n);
  });

  it("rejects a negative nonce before any signing work", () => {
    assert.throws(() =>
      buildPaymentPlan({
        nonce: -1,
        baseFee: 5_000_000n,
        feeCapWei: DEFAULT_FEE_CAP_WEI,
        to: TO,
        value: 1n,
      }),
    );
  });
});
