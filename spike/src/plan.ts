import type { Address } from "viem";
import { TRANSFER_GAS } from "./constants.js";
import { replacementFees, underpricedFees, type GasFees } from "./fees.js";

export interface UnsignedPayment {
  chainId: number;
  nonce: number;
  gas: bigint;
  to: Address;
  value: bigint;
  type: "eip1559";
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface PaymentPlan {
  nonce: number;
  baseFee: bigint;
  underpriced: UnsignedPayment;
  replacement: UnsignedPayment;
  underpricedFees: GasFees;
  replacementFees: GasFees;
}

export function buildPaymentPlan(input: {
  chainId: number;
  minBaseFeeWei: bigint;
  nonce: number;
  baseFee: bigint;
  feeCapWei: bigint;
  to: Address;
  value: bigint;
  gas?: bigint;
  bumpBps?: bigint;
  suggestedPriorityFee?: bigint;
}): PaymentPlan {
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
    throw new Error(`chainId must be a positive integer, got ${input.chainId}`);
  }
  if (!Number.isInteger(input.nonce) || input.nonce < 0) {
    throw new Error(`nonce must be a non-negative integer, got ${input.nonce}`);
  }
  const low = underpricedFees(input.baseFee, input.minBaseFeeWei);
  const high = replacementFees({
    baseFee: input.baseFee,
    stuck: low,
    feeCapWei: input.feeCapWei,
    bumpBps: input.bumpBps,
    suggestedPriorityFee: input.suggestedPriorityFee,
  });
  const shared = {
    chainId: input.chainId,
    nonce: input.nonce,
    gas: input.gas ?? TRANSFER_GAS,
    to: input.to,
    value: input.value,
    type: "eip1559" as const,
  };
  return {
    nonce: input.nonce,
    baseFee: input.baseFee,
    underpricedFees: low,
    replacementFees: high,
    underpriced: { ...shared, ...low },
    replacement: { ...shared, ...high },
  };
}

export function assertSameNonceReplacement(plan: PaymentPlan): void {
  if (plan.underpriced.nonce !== plan.replacement.nonce) {
    throw new Error(
      `Replacement nonce ${plan.replacement.nonce} does not match stuck nonce ${plan.underpriced.nonce}`,
    );
  }
  if (plan.underpriced.chainId !== plan.replacement.chainId) {
    throw new Error("Replacement chain id does not match the stuck transaction");
  }
  if (plan.replacement.maxFeePerGas <= plan.underpriced.maxFeePerGas) {
    throw new Error("Replacement maxFeePerGas is not higher than the stuck transaction");
  }
  if (plan.replacement.maxPriorityFeePerGas <= plan.underpriced.maxPriorityFeePerGas) {
    throw new Error(
      "Replacement maxPriorityFeePerGas is not higher than the stuck transaction",
    );
  }
  if (plan.underpriced.maxFeePerGas >= plan.baseFee) {
    throw new Error("Stuck transaction maxFeePerGas is not below the base fee");
  }
}
