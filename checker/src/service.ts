import { decide, type Observation } from "./policy.js";

export interface SentTx {
  hash: string;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  mpcMs: number;
}

export interface EvmPort {
  getNonce(): Promise<number>;
  getBaseFee(): Promise<bigint>;
  quoteReplacement(): Promise<
    | { ok: true; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
    | { ok: false; reason: string }
  >;
  sendUnderpriced(nonce: number): Promise<
    | ({ ok: true } & SentTx)
    | { ok: false; feeRelated: boolean; reason: string }
  >;
  sendReplacement(nonce: number): Promise<
    | ({ ok: true } & SentTx)
    | { ok: false; feeRelated: boolean; reason: string }
  >;
  getTx(hash: string): Promise<
    | { status: "pending" | "absent"; maxFeePerGas: bigint; baseFee: bigint }
    | { status: "mined"; confirmations: number }
  >;
}

export interface GuaranteeView {
  status: "Open" | "Delivered" | "Claimed";
  proofTxHash: string | null;
  agent: string;
  coverage: bigint;
}

export interface GuaranteePort {
  nowNs(): Promise<bigint>;
  buy(input: {
    destinationChain: string;
    recipient: string;
    amount: bigint;
    coverage: bigint;
    deadlineNs: bigint;
  }): Promise<{ id: number; deadlineNs: bigint; nearTxHash: string }>;
  submitProof(id: number, txHash: string): Promise<{ nearTxHash: string }>;
  claim(id: number): Promise<{ nearTxHash: string }>;
  getGuarantee(id: number): Promise<GuaranteeView | null>;
}

export interface RunRequest {
  destinationChain: string;
  recipient: string;
  amount: bigint;
  coverage: bigint;
  deadlineNs: bigint;
  requiredConfirmations: number;
  stuckAfterMs: number;
  rescueBudgetMs: number;
  msPerConfirmation: number;
  feeCapWei: bigint;
  pollMs: number;
}

export interface RunReport {
  guaranteeId: number;
  buyTxHash: string;
  deadlineNs: string;
  outcome: "proved" | "left_for_claim";
  reason: string | null;
  nonce: number;
  underpriced: SentTx | null;
  replacement: SentTx | null;
  provedHash: string | null;
  proofTxHash: string | null;
  pendingForMs: number;
  sawPending: boolean;
  confirmations: number | null;
  /** Dry 1-Click quote for an optional USDC-on-Base delivery of a NEAR claim. Null when the payment was proved. */
  payoutQuote: unknown;
}

export async function runGuaranteedPayment(input: {
  near: GuaranteePort;
  evm: EvmPort;
  request: RunRequest;
  sleep: (ms: number) => Promise<void>;
  onDecision?: (decision: { type: string; reason?: string }, nowMs: number) => void;
  quotePayout?: () => Promise<unknown>;
}): Promise<RunReport> {
  const bought = await input.near.buy({
    destinationChain: input.request.destinationChain,
    recipient: input.request.recipient,
    amount: input.request.amount,
    coverage: input.request.coverage,
    deadlineNs: input.request.deadlineNs,
  });
  const deadlineMs = Number(bought.deadlineNs / 1_000_000n);
  const nonce = await input.evm.getNonce();

  let hash: string | null = null;
  let underpriced: SentTx | null = null;
  let replacement: SentTx | null = null;
  let alreadyBumped = false;
  let pendingSinceMs: number | null = null;
  let pendingForMs = 0;
  let sawPending = false;
  let rejected: { feeRelated: boolean } | null = null;
  let confirmations: number | null = null;
  const onDecision = input.onDecision;

  for (let step = 0; step < 200; step++) {
    const now = await nowMs(input.near);
    const observation = await observe();
    const quote = await input.evm.quoteReplacement();
    const decision = decide({
      nowMs: now,
      deadlineMs,
      requiredConfirmations: input.request.requiredConfirmations,
      stuckAfterMs: input.request.stuckAfterMs,
      rescueBudgetMs: input.request.rescueBudgetMs,
      msPerConfirmation: input.request.msPerConfirmation,
      alreadyBumped,
      replacementMaxFeePerGas: quote.ok ? quote.maxFeePerGas : null,
      feeCapWei: input.request.feeCapWei,
      observation,
    });
    onDecision?.(
      decision.type === "give_up"
        ? { type: decision.type, reason: decision.reason }
        : { type: decision.type },
      now,
    );

    if (decision.type === "wait") {
      await input.sleep(input.request.pollMs);
      continue;
    }
    if (decision.type === "send_underpriced") {
      const sent = await input.evm.sendUnderpriced(nonce);
      if (!sent.ok) {
        rejected = { feeRelated: sent.feeRelated };
        if (!sent.feeRelated) {
          return finish("left_for_claim", sent.reason, null);
        }
        continue;
      }
      underpriced = sent;
      hash = sent.hash;
      pendingSinceMs = null;
      pendingForMs = 0;
      continue;
    }
    if (decision.type === "bump") {
      pendingForMs = pendingSinceMs == null ? 0 : now - pendingSinceMs;
      const sent = await input.evm.sendReplacement(nonce);
      alreadyBumped = true;
      if (!sent.ok) {
        return finish("left_for_claim", sent.reason, null);
      }
      replacement = sent;
      hash = sent.hash;
      pendingSinceMs = null;
      continue;
    }
    if (decision.type === "submit_proof") {
      const proof = await input.near.submitProof(bought.id, decision.hash);
      confirmations =
        observation.kind === "mined" ? observation.confirmations : confirmations;
      return finish("proved", null, proof.nearTxHash, decision.hash);
    }
    return finish("left_for_claim", decision.reason, null);
  }

  return finish("left_for_claim", "checker stopped before the deadline", null);

  async function observe(): Promise<Observation> {
    if (!hash) {
      return rejected
        ? { kind: "rejected", feeRelated: rejected.feeRelated }
        : { kind: "unsent" };
    }
    const tx = await input.evm.getTx(hash);
    if (tx.status === "mined") {
      confirmations = tx.confirmations;
      return { kind: "mined", hash, confirmations: tx.confirmations };
    }
    if (tx.status === "pending") {
      sawPending = true;
    }
    const now = await nowMs(input.near);
    if (pendingSinceMs == null) {
      pendingSinceMs = now;
    }
    pendingForMs = now - pendingSinceMs;
    return {
      kind: tx.status,
      hash,
      pendingForMs,
      maxFeePerGas: tx.maxFeePerGas,
      baseFee: tx.baseFee,
    };
  }

  async function finish(
    outcome: RunReport["outcome"],
    reason: string | null,
    proofTxHash: string | null,
    provedHash: string | null = null,
  ): Promise<RunReport> {
    return {
      guaranteeId: bought.id,
      buyTxHash: bought.nearTxHash,
      deadlineNs: bought.deadlineNs.toString(),
      outcome,
      reason,
      nonce,
      underpriced,
      replacement,
      provedHash,
      proofTxHash,
      pendingForMs,
      sawPending,
      confirmations,
      payoutQuote: outcome === "left_for_claim" ? await loadQuote() : null,
    };
  }

  async function loadQuote(): Promise<unknown> {
    if (!input.quotePayout) {
      return null;
    }
    try {
      return await input.quotePayout();
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function nowMs(near: GuaranteePort): Promise<number> {
  return Number((await near.nowNs()) / 1_000_000n);
}

/** Agent-side settlement. The checker does not call this when it proved delivery. */
export async function claimIfStillOpen(
  near: GuaranteePort,
  guaranteeId: number,
): Promise<{ claimed: boolean; nearTxHash: string | null; status: string }> {
  const current = await near.getGuarantee(guaranteeId);
  if (!current) {
    throw new Error(`guarantee ${guaranteeId} not found`);
  }
  if (current.status !== "Open") {
    return { claimed: false, nearTxHash: null, status: current.status };
  }
  const claimed = await near.claim(guaranteeId);
  return { claimed: true, nearTxHash: claimed.nearTxHash, status: "Claimed" };
}
