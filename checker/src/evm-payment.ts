import { isIngressFeeRejection } from "../../spike/src/errors.js";
import { FeeCapExceededError } from "../../spike/src/fees.js";
import { buildPaymentPlan } from "../../spike/src/plan.js";
import {
  broadcastSigned,
  readBaseFee,
  signPayment,
  suggestPriorityFee,
  type BaseClient,
} from "../../spike/src/chain.js";
import type { SpikeConfig } from "../../spike/src/config.js";
import type { EvmPort, SentTx } from "./service.js";

type MpcContext = Parameters<typeof signPayment>[0];

/**
 * Sepolia payments signed by the spike's Chain Signatures path.
 * The underpriced transaction uses the same fee formula as the day-1 spike.
 */
export function createEvmPort(input: {
  config: SpikeConfig;
  readClient: BaseClient;
  submitClient: BaseClient;
  from: `0x${string}`;
  signing: Omit<MpcContext, "readClient" | "payment" | "from">;
}): EvmPort {
  const { config, readClient, submitClient, from, signing } = input;

  async function planFor(nonce: number) {
    const [baseFee, suggestedPriorityFee] = await Promise.all([
      readBaseFee(readClient),
      suggestPriorityFee(readClient),
    ]);
    return buildPaymentPlan({
      chainId: config.chain.chainId,
      minBaseFeeWei: config.chain.minBaseFeeWei,
      nonce,
      baseFee,
      feeCapWei: config.feeCapWei,
      to: config.paymentTo,
      value: config.paymentWei,
      bumpBps: config.bumpBps,
      suggestedPriorityFee,
    });
  }

  async function signAndSend(
    nonce: number,
    which: "underpriced" | "replacement",
  ): Promise<({ ok: true } & SentTx) | { ok: false; feeRelated: boolean; reason: string }> {
    let plan;
    try {
      plan = await planFor(nonce);
    } catch (error) {
      if (error instanceof FeeCapExceededError) {
        return { ok: false, feeRelated: true, reason: error.message };
      }
      throw error;
    }
    const payment = plan[which];
    const signed = await signPayment({
      ...signing,
      readClient,
      from,
      payment,
    });
    let sent = await broadcastSigned(submitClient, signed.serialized);
    for (let attempt = 1; attempt < 5 && !sent.ok && isIngressFeeRejection(sent.failure.kind); attempt++) {
      console.log(
        `underpriced broadcast rejected (${sent.failure.message}); retry ${attempt} of the same signed transaction`,
      );
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      sent = await broadcastSigned(submitClient, signed.serialized);
    }
    if (!sent.ok) {
      return {
        ok: false,
        feeRelated: isIngressFeeRejection(sent.failure.kind),
        reason: `${sent.failure.kind}: ${sent.failure.message}`,
      };
    }
    return {
      ok: true,
      hash: sent.hash,
      nonce: signed.nonce,
      maxFeePerGas: signed.maxFeePerGas,
      maxPriorityFeePerGas: signed.maxPriorityFeePerGas,
      mpcMs: signed.mpcMs,
    };
  }

  return {
    async getNonce() {
      return readClient.getTransactionCount({ address: from, blockTag: "latest" });
    },
    async getBaseFee() {
      return readBaseFee(readClient);
    },
    async quoteReplacement() {
      try {
        const plan = await planFor(0);
        return {
          ok: true,
          maxFeePerGas: plan.replacement.maxFeePerGas,
          maxPriorityFeePerGas: plan.replacement.maxPriorityFeePerGas,
        };
      } catch (error) {
        if (error instanceof FeeCapExceededError) {
          return { ok: false, reason: error.message };
        }
        throw error;
      }
    },
    async sendUnderpriced(nonce) {
      const first = await signAndSend(nonce, "underpriced");
      if (first.ok || !first.feeRelated) {
        return first;
      }
      console.log(`underpriced payment was rejected (${first.reason}); signing once more`);
      return signAndSend(nonce, "underpriced");
    },
    sendReplacement: (nonce) => signAndSend(nonce, "replacement"),
    async getTx(hash) {
      const baseFee = await readBaseFee(readClient);
      const receipt = await readClient.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);
      if (receipt) {
        const block = await readClient.getBlockNumber();
        return {
          status: "mined" as const,
          confirmations: Number(block - receipt.blockNumber) + 1,
        };
      }
      const tx = await readClient.getTransaction({ hash: hash as `0x${string}` }).catch(() => null);
      const maxFeePerGas = tx?.maxFeePerGas ?? 0n;
      if (tx && tx.blockNumber == null) {
        return { status: "pending" as const, maxFeePerGas, baseFee };
      }
      if (tx && tx.blockNumber != null) {
        const block = await readClient.getBlockNumber();
        return {
          status: "mined" as const,
          confirmations: Number(block - tx.blockNumber) + 1,
        };
      }
      return { status: "absent" as const, maxFeePerGas, baseFee };
    },
  };
}
