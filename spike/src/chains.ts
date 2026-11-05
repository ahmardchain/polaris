import { baseSepolia, sepolia, type Chain } from "viem/chains";
import {
  BASE_SEPOLIA_MIN_BASE_FEE_WEI,
  DEFAULT_FEE_CAP_WEI,
  EIP1559_PRACTICAL_MIN_BASE_FEE_WEI,
} from "./constants.js";

export interface EvmChainProfile {
  key: "base-sepolia" | "ethereum-sepolia";
  name: string;
  chainId: number;
  viemChain: Chain;
  defaultRpcUrl: string;
  defaultSubmitUrl: string;
  explorerTxBase: string;
  /**
   * A max fee strictly below this cannot be included. Base publishes a
   * protocol minimum. Ethereum's EIP-1559 update truncates to zero once the
   * base fee is under 8 wei, so 7 wei is the practical floor.
   */
  minBaseFeeWei: bigint;
  defaultFeeCapWei: bigint;
  /** Blocks are ~2s on Base and ~12s on Ethereum. Watch long enough to span several. */
  defaultStuckWaitMs: number;
}

export const EVM_CHAINS = {
  "base-sepolia": {
    key: "base-sepolia",
    name: "Base Sepolia",
    chainId: 84532,
    viemChain: baseSepolia,
    defaultRpcUrl: "https://sepolia.base.org",
    defaultSubmitUrl: "https://sepolia-sequencer.base.org",
    explorerTxBase: "https://sepolia.basescan.org/tx",
    minBaseFeeWei: BASE_SEPOLIA_MIN_BASE_FEE_WEI,
    defaultFeeCapWei: DEFAULT_FEE_CAP_WEI,
    defaultStuckWaitMs: 12_000,
  },
  "ethereum-sepolia": {
    key: "ethereum-sepolia",
    name: "Ethereum Sepolia",
    chainId: 11_155_111,
    viemChain: sepolia,
    defaultRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    defaultSubmitUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorerTxBase: "https://sepolia.etherscan.io/tx",
    minBaseFeeWei: EIP1559_PRACTICAL_MIN_BASE_FEE_WEI,
    defaultFeeCapWei: DEFAULT_FEE_CAP_WEI,
    defaultStuckWaitMs: 36_000,
  },
} as const satisfies Record<string, EvmChainProfile>;

export type EvmChainKey = keyof typeof EVM_CHAINS;

export function resolveEvmChain(key: string): EvmChainProfile {
  if (!Object.prototype.hasOwnProperty.call(EVM_CHAINS, key)) {
    throw new Error(
      `EVM_CHAIN must be one of ${Object.keys(EVM_CHAINS).join(", ")}, got ${key}`,
    );
  }
  return EVM_CHAINS[key as EvmChainKey];
}

export function explorerTxUrl(chain: EvmChainProfile, hash: string): string {
  return `${chain.explorerTxBase}/${hash}`;
}
