/**
 * Pure decisions for the checker. No network, no clock of its own.
 * The service feeds it observations and acts on the result.
 */
export type Observation =
  | { kind: "unsent" }
  | { kind: "rejected"; feeRelated: boolean }
  | {
      kind: "pending" | "absent";
      hash: string;
      pendingForMs: number;
      maxFeePerGas: bigint;
      baseFee: bigint;
    }
  | { kind: "mined"; hash: string; confirmations: number };

export interface PolicyInput {
  nowMs: number;
  deadlineMs: number;
  requiredConfirmations: number;
  stuckAfterMs: number;
  /** Time to sign a replacement and wait for it to confirm. */
  rescueBudgetMs: number;
  /** Time for one more confirmation. */
  msPerConfirmation: number;
  alreadyBumped: boolean;
  replacementMaxFeePerGas: bigint | null;
  feeCapWei: bigint;
  observation: Observation;
}

export type Decision =
  | { type: "send_underpriced" }
  | { type: "wait" }
  | { type: "bump" }
  | { type: "submit_proof"; hash: string }
  | { type: "give_up"; reason: string };

export function decide(input: PolicyInput): Decision {
  if (input.nowMs >= input.deadlineMs) {
    return { type: "give_up", reason: "deadline passed before proof" };
  }

  const observation = input.observation;
  if (observation.kind === "unsent") {
    return { type: "send_underpriced" };
  }

  if (observation.kind === "mined") {
    if (observation.confirmations >= input.requiredConfirmations) {
      return { type: "submit_proof", hash: observation.hash };
    }
    const blocksLeft = input.requiredConfirmations - observation.confirmations;
    if (input.nowMs + blocksLeft * input.msPerConfirmation >= input.deadlineMs) {
      return { type: "give_up", reason: "not enough time for confirmations" };
    }
    return { type: "wait" };
  }

  if (observation.kind === "rejected" && !observation.feeRelated) {
    return { type: "give_up", reason: "broadcast rejected" };
  }

  const waited =
    observation.kind === "pending" || observation.kind === "absent"
      ? observation.pendingForMs
      : input.stuckAfterMs;
  const readyToAct = observation.kind === "rejected" || waited >= input.stuckAfterMs;

  if (!readyToAct) {
    return { type: "wait" };
  }

  if (!input.alreadyBumped && canBump(input)) {
    return { type: "bump" };
  }

  if (
    input.alreadyBumped &&
    input.nowMs + input.requiredConfirmations * input.msPerConfirmation >= input.deadlineMs
  ) {
    return { type: "give_up", reason: "replacement did not mine before the deadline" };
  }

  return { type: "wait" };
}

function canBump(input: PolicyInput): boolean {
  if (
    input.replacementMaxFeePerGas == null ||
    input.replacementMaxFeePerGas > input.feeCapWei
  ) {
    return false;
  }
  return input.nowMs + input.rescueBudgetMs < input.deadlineMs;
}
