import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BASE_SEPOLIA_MIN_BASE_FEE_WEI,
  DEFAULT_FEE_CAP_WEI,
} from "./constants.js";
import {
  FeeCapExceededError,
  bumpByBps,
  feesCoverBaseFee,
  replacementFees,
  underpricedFees,
} from "./fees.js";

describe("underpricedFees", () => {
  it("stays below the live base fee and the Base Sepolia floor", () => {
    const fees = underpricedFees(BASE_SEPOLIA_MIN_BASE_FEE_WEI);
    assert.equal(fees.maxFeePerGas, BASE_SEPOLIA_MIN_BASE_FEE_WEI / 2n);
    assert.equal(fees.maxPriorityFeePerGas, 1n);
    assert.ok(fees.maxFeePerGas < BASE_SEPOLIA_MIN_BASE_FEE_WEI);
    assert.ok(fees.maxPriorityFeePerGas <= fees.maxFeePerGas);
  });

  it("stays under the floor when the live base fee is higher", () => {
    const baseFee = 50_000_000n;
    const fees = underpricedFees(baseFee);
    assert.equal(fees.maxFeePerGas, BASE_SEPOLIA_MIN_BASE_FEE_WEI / 2n);
    assert.ok(fees.maxFeePerGas < baseFee);
    assert.ok(fees.maxFeePerGas < BASE_SEPOLIA_MIN_BASE_FEE_WEI);
  });

  it("uses half the live base fee when that is already under the floor", () => {
    const fees = underpricedFees(1_000n, BASE_SEPOLIA_MIN_BASE_FEE_WEI);
    assert.equal(fees.maxFeePerGas, 500n);
    assert.ok(fees.maxFeePerGas < 1_000n);
  });
});

describe("replacementFees", () => {
  const baseFee = 5_000_000n;
  const stuck = underpricedFees(baseFee);

  it("bumps both fields by at least 10% and clears twice the base fee", () => {
    const next = replacementFees({
      baseFee,
      stuck,
      feeCapWei: DEFAULT_FEE_CAP_WEI,
      bumpBps: 1_000n,
    });
    assert.ok(next.maxFeePerGas >= bumpByBps(stuck.maxFeePerGas, 1_000n));
    assert.ok(
      next.maxPriorityFeePerGas >= bumpByBps(stuck.maxPriorityFeePerGas, 1_000n),
    );
    assert.ok(next.maxFeePerGas >= baseFee * 2n + next.maxPriorityFeePerGas);
    assert.ok(next.maxPriorityFeePerGas <= next.maxFeePerGas);
    assert.ok(feesCoverBaseFee(next, baseFee));
    assert.ok(next.maxFeePerGas > stuck.maxFeePerGas);
    assert.ok(next.maxFeePerGas <= DEFAULT_FEE_CAP_WEI);
  });

  it("rounds a 1 wei priority fee up so the 10% bump is visible", () => {
    assert.equal(bumpByBps(1n, 1_000n), 2n);
  });

  it("adopts a network tip when it fits under the cap", () => {
    const next = replacementFees({
      baseFee,
      stuck,
      feeCapWei: DEFAULT_FEE_CAP_WEI,
      suggestedPriorityFee: 2_000_000n,
    });
    assert.equal(next.maxPriorityFeePerGas, 2_000_000n);
    assert.equal(next.maxFeePerGas, baseFee * 2n + 2_000_000n);
  });

  it("ignores a network tip that would exceed the cap and still builds an includable fee", () => {
    const next = replacementFees({
      baseFee,
      stuck,
      feeCapWei: 50_000_000n,
      suggestedPriorityFee: 100_000_000_000n,
    });
    assert.ok(next.maxPriorityFeePerGas <= 50_000_000n);
    assert.ok(next.maxFeePerGas <= 50_000_000n);
    assert.ok(next.maxFeePerGas >= baseFee * 2n);
  });

  it("refuses to sign when inclusion would break the cap", () => {
    assert.throws(
      () =>
        replacementFees({
          baseFee,
          stuck,
          feeCapWei: 1_000n,
        }),
      (error: unknown) => {
        assert.ok(error instanceof FeeCapExceededError);
        assert.ok(error.requiredMaxFeePerGas > error.feeCapWei);
        return true;
      },
    );
  });
});
