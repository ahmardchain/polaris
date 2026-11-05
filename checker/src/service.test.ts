import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimIfStillOpen,
  runGuaranteedPayment,
  type EvmPort,
  type GuaranteePort,
  type RunRequest,
  type SentTx,
} from "./service.js";

function request(deadlineMs: number): RunRequest {
  return {
    destinationChain: "ethereum-sepolia",
    recipient: "0x000000000000000000000000000000000000dEaD",
    amount: 1n,
    coverage: 200_000_000_000_000_000_000n,
    deadlineNs: BigInt(deadlineMs) * 1_000_000n,
    requiredConfirmations: 2,
    stuckAfterMs: 24_000,
    rescueBudgetMs: 90_000,
    msPerConfirmation: 15_000,
    feeCapWei: 1_000_000_000n,
    pollMs: 24_000,
  };
}

function harness(deadlineMs: number) {
  let now = 0;
  const proofs: string[] = [];
  const claims: number[] = [];
  let status: "Open" | "Delivered" | "Claimed" = "Open";
  const near: GuaranteePort = {
    async nowNs() {
      return BigInt(now) * 1_000_000n;
    },
    async buy() {
      return { id: 4, deadlineNs: BigInt(deadlineMs) * 1_000_000n, nearTxHash: "buy-near" };
    },
    async submitProof(_id, txHash) {
      proofs.push(txHash);
      status = "Delivered";
      return { nearTxHash: "proof-near" };
    },
    async claim(id) {
      claims.push(id);
      status = "Claimed";
      return { nearTxHash: "claim-near" };
    },
    async getGuarantee() {
      return {
        status,
        proofTxHash: proofs[0] ?? null,
        agent: "agent.testnet",
        coverage: 200_000_000_000_000_000_000n,
      };
    },
  };
  const sleep = async (ms: number) => {
    now += ms;
  };
  return { near, sleep, proofs, claims, get now() { return now; } };
}

function tx(partial: Partial<SentTx> & Pick<SentTx, "hash" | "maxFeePerGas">): SentTx {
  return {
    nonce: 1,
    maxPriorityFeePerGas: 1n,
    mpcMs: 5,
    ...partial,
  };
}

describe("runGuaranteedPayment", () => {
  it("fee-bumps a stuck transaction and submits the landed hash", async () => {
    const clock = harness(600_000);
    let bumped = false;
    const evm: EvmPort = {
      async getNonce() {
        return 1;
      },
      async getBaseFee() {
        return 21n;
      },
      async quoteReplacement() {
        return { ok: true, maxFeePerGas: 1_000_034n, maxPriorityFeePerGas: 1_000_000n };
      },
      async sendUnderpriced() {
        return { ok: true, ...tx({ hash: "0xunder", maxFeePerGas: 3n, mpcMs: 28_000 }) };
      },
      async sendReplacement() {
        bumped = true;
        return { ok: true, ...tx({ hash: "0xrepl", maxFeePerGas: 1_000_034n, maxPriorityFeePerGas: 1_000_000n, mpcMs: 30_000 }) };
      },
      async getTx(hash) {
        if (hash === "0xrepl") {
          return { status: "mined", confirmations: 2 };
        }
        return { status: "pending", maxFeePerGas: 3n, baseFee: 21n };
      },
    };

    const report = await runGuaranteedPayment({
      near: clock.near,
      evm,
      request: request(600_000),
      sleep: clock.sleep,
    });

    assert.equal(bumped, true);
    assert.equal(report.outcome, "proved");
    assert.equal(report.provedHash, "0xrepl");
    assert.deepEqual(clock.proofs, ["0xrepl"]);
    assert.deepEqual(clock.claims, []);
    assert.equal(report.underpriced?.hash, "0xunder");
    assert.equal(report.replacement?.hash, "0xrepl");
    assert.ok(report.pendingForMs >= 24_000);
    assert.equal(report.nonce, 1);
  });

  it("leaves the guarantee open when a bump cannot finish before the deadline", async () => {
    const clock = harness(90_000);
    let bumps = 0;
    const evm: EvmPort = {
      async getNonce() {
        return 2;
      },
      async getBaseFee() {
        return 21n;
      },
      async quoteReplacement() {
        return { ok: true, maxFeePerGas: 1_000_034n, maxPriorityFeePerGas: 1_000_000n };
      },
      async sendUnderpriced() {
        return { ok: true, ...tx({ hash: "0xstuck", maxFeePerGas: 3n }) };
      },
      async sendReplacement() {
        bumps += 1;
        return { ok: true, ...tx({ hash: "0xshould-not", maxFeePerGas: 1_000_034n }) };
      },
      async getTx() {
        return { status: "pending", maxFeePerGas: 3n, baseFee: 21n };
      },
    };

    const report = await runGuaranteedPayment({
      near: clock.near,
      evm,
      request: request(90_000),
      sleep: clock.sleep,
    });

    assert.equal(bumps, 0);
    assert.equal(report.outcome, "left_for_claim");
    assert.equal(report.reason, "deadline passed before proof");
    assert.deepEqual(clock.proofs, []);
    assert.equal(report.underpriced?.hash, "0xstuck");
    assert.equal(report.replacement, null);

    const claimed = await claimIfStillOpen(clock.near, report.guaranteeId);
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.nearTxHash, "claim-near");
    const again = await claimIfStillOpen(clock.near, report.guaranteeId);
    assert.equal(again.claimed, false);
    assert.equal(again.status, "Claimed");
  });

  it("does not claim a guarantee that was already proved", async () => {
    const clock = harness(600_000);
    const skip: GuaranteePort = {
      ...clock.near,
      async getGuarantee() {
        return {
          status: "Delivered",
          proofTxHash: "0xrepl",
          agent: "agent.testnet",
          coverage: 1n,
        };
      },
    };
    const result = await claimIfStillOpen(skip, 4);
    assert.equal(result.claimed, false);
    assert.equal(result.status, "Delivered");
    assert.deepEqual(clock.claims, []);
  });
});
