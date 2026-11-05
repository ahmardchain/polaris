import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { getTransactionLastResult } from "@near-js/utils";
import type { GuaranteePort, GuaranteeView } from "./service.js";

const CALL_GAS = 30_000_000_000_000n;
const BUY_GAS = 80_000_000_000_000n;

export interface PoolState {
  poolBalance: bigint;
  outstandingCoverage: bigint;
  freeCoverage: bigint;
  premium: bigint;
}

export interface GuaranteeClient extends GuaranteePort {
  contractId: string;
  fundPool(amount: bigint): Promise<string>;
  getPool(): Promise<PoolState>;
}

export function createGuaranteeClient(input: {
  account: Account;
  provider: JsonRpcProvider;
  contractId: string;
}): GuaranteeClient {
  const { account, provider, contractId } = input;

  async function premium(): Promise<bigint> {
    const config = await provider.callFunction(contractId, "get_config", {});
    return asBigint(field(config, "premium"));
  }

  return {
    contractId,
    async nowNs() {
      const status = (await provider.status()) as {
        sync_info: { latest_block_time: string };
      };
      const ms = Date.parse(status.sync_info.latest_block_time);
      if (!Number.isFinite(ms)) {
        throw new Error("NEAR status did not include a block time");
      }
      return BigInt(ms) * 1_000_000n;
    },
    async buy(request) {
      const deposit = await premium();
      const outcome = await account.callFunctionRaw({
        contractId,
        methodName: "buy_guarantee",
        args: {
          destination_chain: request.destinationChain,
          recipient: request.recipient,
          amount: request.amount.toString(),
          coverage: request.coverage.toString(),
          deadline: request.deadlineNs.toString(),
        },
        deposit,
        gas: BUY_GAS,
        waitUntil: "FINAL",
      });
      const raw = getTransactionLastResult(outcome);
      return {
        id: Number(asBigint(raw)),
        deadlineNs: request.deadlineNs,
        nearTxHash: outcome.transaction.hash,
      };
    },
    async submitProof(id, txHash) {
      const outcome = await account.callFunctionRaw({
        contractId,
        methodName: "submit_proof",
        args: { guarantee_id: id, tx_hash: txHash },
        gas: CALL_GAS,
        waitUntil: "FINAL",
      });
      return { nearTxHash: outcome.transaction.hash };
    },
    async claim(id) {
      const outcome = await account.callFunctionRaw({
        contractId,
        methodName: "claim",
        args: { guarantee_id: id },
        gas: CALL_GAS,
        waitUntil: "FINAL",
      });
      return { nearTxHash: outcome.transaction.hash };
    },
    async getGuarantee(id) {
      const raw = await provider.callFunction(contractId, "get_guarantee", {
        guarantee_id: id,
      });
      if (raw == null) {
        return null;
      }
      const record = raw as {
        status: unknown;
        proof_tx_hash: string | null;
        agent: string;
        coverage: string;
      };
      const view: GuaranteeView = {
        status: parseStatus(record.status),
        proofTxHash: record.proof_tx_hash,
        agent: record.agent,
        coverage: asBigint(record.coverage),
      };
      return view;
    },
    async fundPool(amount) {
      const outcome = await account.callFunctionRaw({
        contractId,
        methodName: "fund_pool",
        args: {},
        deposit: amount,
        gas: CALL_GAS,
        waitUntil: "FINAL",
      });
      return outcome.transaction.hash;
    },
    async getPool() {
      const raw = (await provider.callFunction(contractId, "get_pool", {})) as {
        pool_balance: string;
        outstanding_coverage: string;
        free_coverage: string;
        premium: string;
      };
      return {
        poolBalance: asBigint(raw.pool_balance),
        outstandingCoverage: asBigint(raw.outstanding_coverage),
        freeCoverage: asBigint(raw.free_coverage),
        premium: asBigint(raw.premium),
      };
    },
  };
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) {
    throw new Error(`missing ${key} in ${JSON.stringify(value)}`);
  }
  return (value as Record<string, unknown>)[key];
}

function asBigint(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(`expected an integer, got ${JSON.stringify(value)}`);
}

function parseStatus(value: unknown): GuaranteeView["status"] {
  if (value === "Open" || value === "Delivered" || value === "Claimed") {
    return value;
  }
  if (value && typeof value === "object") {
    if ("Open" in value) return "Open";
    if ("Delivered" in value) return "Delivered";
    if ("Claimed" in value) return "Claimed";
  }
  throw new Error(`unexpected guarantee status ${JSON.stringify(value)}`);
}
