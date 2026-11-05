import {
  DEFAULT_REPLACEMENT_BUMP_BPS,
  EIP1559_PRACTICAL_MIN_BASE_FEE_WEI,
  MODEST_PRIORITY_FEE_WEI,
} from "./constants.js";

export interface GasFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export class FeeCapExceededError extends Error {
  readonly requiredMaxFeePerGas: bigint;
  readonly requiredMaxPriorityFeePerGas: bigint;
  readonly feeCapWei: bigint;

  constructor(
    requiredMaxFeePerGas: bigint,
    requiredMaxPriorityFeePerGas: bigint,
    feeCapWei: bigint,
  ) {
    super(
      `Replacement needs maxFeePerGas ${requiredMaxFeePerGas} wei and maxPriorityFeePerGas ${requiredMaxPriorityFeePerGas} wei, which exceeds FEE_CAP_WEI ${feeCapWei}. Refusing to sign so the pool cannot overpay.`,
    );
    this.name = "FeeCapExceededError";
    this.requiredMaxFeePerGas = requiredMaxFeePerGas;
    this.requiredMaxPriorityFeePerGas = requiredMaxPriorityFeePerGas;
    this.feeCapWei = feeCapWei;
  }
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("denominator must be positive");
  }
  return (numerator + denominator - 1n) / denominator;
}

/** Round a wei value up by `bumpBps` basis points (1000 bps = 10%). */
export function bumpByBps(value: bigint, bumpBps: bigint): bigint {
  if (value < 0n) {
    throw new Error("fee must be non-negative");
  }
  if (bumpBps < 0n) {
    throw new Error("bump bps must be non-negative");
  }
  return ceilDiv(value * (10_000n + bumpBps), 10_000n);
}

/**
 * Fees that are strictly below the live base fee and, when the chain is at
 * or above its minimum base fee, strictly below that floor as well.
 * EIP-1559 requires maxPriorityFeePerGas <= maxFeePerGas.
 */
export function underpricedFees(
  baseFee: bigint,
  minBaseFee: bigint = EIP1559_PRACTICAL_MIN_BASE_FEE_WEI,
): GasFees {
  if (baseFee < 2n) {
    throw new Error(
      `Base fee ${baseFee} wei is too small to build a strictly underpriced transaction`,
    );
  }
  const ceiling = baseFee < minBaseFee ? baseFee : minBaseFee;
  const maxFeePerGas = ceiling / 2n;
  if (maxFeePerGas < 1n || maxFeePerGas >= baseFee) {
    throw new Error(
      `Underpriced maxFeePerGas ${maxFeePerGas} is not strictly below base fee ${baseFee}`,
    );
  }
  if (baseFee >= minBaseFee && maxFeePerGas >= minBaseFee) {
    throw new Error(
      "Underpriced maxFeePerGas is not below the chain minimum base fee",
    );
  }
  return {
    maxFeePerGas,
    maxPriorityFeePerGas: 1n,
  };
}

export interface ReplacementFeeInput {
  baseFee: bigint;
  stuck: GasFees;
  feeCapWei: bigint;
  /** Increase over the stuck fees. Default is 10% (1000 bps), Base's replacement minimum. */
  bumpBps?: bigint;
  /**
   * Tip suggested by the RPC. Used only when it still fits under the fee cap.
   * A large suggestion must not force the pool past its cap on an empty testnet.
   */
  suggestedPriorityFee?: bigint;
}

/**
 * Same-nonce replacement fees.
 *
 * The result is at least `bumpBps` above both stuck fee fields (so the pool
 * accepts the replacement) and at least `baseFee * 2 + priority` (so it can
 * be included if the base fee doubles). Either field above `feeCapWei` throws
 * instead of signing.
 */
export function replacementFees(input: ReplacementFeeInput): GasFees {
  if (input.baseFee < 0n) {
    throw new Error("base fee must be non-negative");
  }
  if (input.feeCapWei < 1n) {
    throw new Error("fee cap must be at least 1 wei");
  }
  const bumpBps = input.bumpBps ?? DEFAULT_REPLACEMENT_BUMP_BPS;
  const bumpedPriority = bumpByBps(input.stuck.maxPriorityFeePerGas, bumpBps);
  let maxPriorityFeePerGas =
    bumpedPriority > MODEST_PRIORITY_FEE_WEI
      ? bumpedPriority
      : MODEST_PRIORITY_FEE_WEI;

  const suggestion = input.suggestedPriorityFee;
  if (suggestion !== undefined && suggestion > maxPriorityFeePerGas) {
    const suggestionMax = input.baseFee * 2n + suggestion;
    if (suggestion <= input.feeCapWei && suggestionMax <= input.feeCapWei) {
      maxPriorityFeePerGas = suggestion;
    }
  }

  const bumpedMax = bumpByBps(input.stuck.maxFeePerGas, bumpBps);
  const inclusionMax = input.baseFee * 2n + maxPriorityFeePerGas;
  let maxFeePerGas = bumpedMax > inclusionMax ? bumpedMax : inclusionMax;
  if (maxFeePerGas < maxPriorityFeePerGas) {
    maxFeePerGas = maxPriorityFeePerGas;
  }

  if (
    maxFeePerGas > input.feeCapWei ||
    maxPriorityFeePerGas > input.feeCapWei
  ) {
    throw new FeeCapExceededError(
      maxFeePerGas,
      maxPriorityFeePerGas,
      input.feeCapWei,
    );
  }

  return { maxFeePerGas, maxPriorityFeePerGas };
}

export function feesCoverBaseFee(fees: GasFees, baseFee: bigint): boolean {
  return fees.maxFeePerGas >= baseFee + fees.maxPriorityFeePerGas;
}
