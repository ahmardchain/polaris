import { getAddress, isAddress, type Address } from "viem";
import {
  DEFAULT_BASE_RPC_URL,
  DEFAULT_BASE_SEQUENCER_URL,
  DEFAULT_DERIVATION_PATH,
  DEFAULT_FEE_CAP_WEI,
  DEFAULT_MPC_CONTRACT_ID,
  DEFAULT_MPC_WAIT_MS,
  DEFAULT_NEAR_RPC_URL,
  DEFAULT_PAYMENT_TO,
  DEFAULT_PAYMENT_WEI,
  DEFAULT_RECEIPT_WAIT_MS,
  DEFAULT_REPLACEMENT_BUMP_BPS,
  DEFAULT_STUCK_POLL_MS,
  DEFAULT_STUCK_WAIT_MS,
} from "./constants.js";

export interface SpikeConfig {
  nearAccountId: string | undefined;
  nearPrivateKey: string | undefined;
  nearRpcUrl: string;
  mpcContractId: string;
  derivationPath: string;
  baseRpcUrl: string;
  baseSequencerUrl: string;
  paymentTo: Address;
  paymentWei: bigint;
  feeCapWei: bigint;
  bumpBps: bigint;
  stuckWaitMs: number;
  stuckPollMs: number;
  receiptWaitMs: number;
  mpcWaitMs: number;
}

function envString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function envBigint(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a base-10 integer, got ${raw}`);
  }
  return BigInt(raw);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a base-10 integer, got ${raw}`);
  }
  return Number(raw);
}

export function loadConfig(): SpikeConfig {
  const paymentTo = envString("PAYMENT_TO", DEFAULT_PAYMENT_TO);
  if (!isAddress(paymentTo)) {
    throw new Error(`PAYMENT_TO is not an EVM address: ${paymentTo}`);
  }
  const nearPrivateKey = process.env.NEAR_PRIVATE_KEY?.trim();
  return {
    nearAccountId: process.env.NEAR_ACCOUNT_ID?.trim() || undefined,
    nearPrivateKey: nearPrivateKey && nearPrivateKey.length > 0 ? nearPrivateKey : undefined,
    nearRpcUrl: envString("NEAR_RPC_URL", DEFAULT_NEAR_RPC_URL),
    mpcContractId: envString("MPC_CONTRACT_ID", DEFAULT_MPC_CONTRACT_ID),
    derivationPath: envString("DERIVATION_PATH", DEFAULT_DERIVATION_PATH),
    baseRpcUrl: envString("BASE_SEPOLIA_RPC_URL", DEFAULT_BASE_RPC_URL),
    baseSequencerUrl: envString("BASE_SEPOLIA_SEQUENCER_URL", DEFAULT_BASE_SEQUENCER_URL),
    paymentTo: getAddress(paymentTo),
    paymentWei: envBigint("PAYMENT_WEI", DEFAULT_PAYMENT_WEI),
    feeCapWei: envBigint("FEE_CAP_WEI", DEFAULT_FEE_CAP_WEI),
    bumpBps: envBigint("REPLACEMENT_BUMP_BPS", BigInt(DEFAULT_REPLACEMENT_BUMP_BPS)),
    stuckWaitMs: envInt("STUCK_WAIT_MS", DEFAULT_STUCK_WAIT_MS),
    stuckPollMs: envInt("STUCK_POLL_MS", DEFAULT_STUCK_POLL_MS),
    receiptWaitMs: envInt("RECEIPT_WAIT_MS", DEFAULT_RECEIPT_WAIT_MS),
    mpcWaitMs: envInt("MPC_WAIT_MS", DEFAULT_MPC_WAIT_MS),
  };
}

export function requireSigner(config: SpikeConfig): {
  nearAccountId: string;
  nearPrivateKey: string;
} {
  if (!config.nearAccountId || !config.nearPrivateKey) {
    throw new Error(
      "NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY are required. Copy spike/.env.example to spike/.env and fill them in. The key is an ed25519: secret from a NEAR testnet full-access key and must not be committed.",
    );
  }
  if (!config.nearPrivateKey.startsWith("ed25519:") && !config.nearPrivateKey.startsWith("secp256k1:")) {
    throw new Error("NEAR_PRIVATE_KEY must be an ed25519: or secp256k1: secret key string");
  }
  return {
    nearAccountId: config.nearAccountId,
    nearPrivateKey: config.nearPrivateKey,
  };
}
