/** Base Sepolia chain id. EIP-1559 transactions include this so they cannot be replayed onto other EVM chains. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * Minimum L2 base fee on Base Sepolia after the Jovian upgrade.
 * Documented at https://docs.base.org/base-chain/network-information/network-fees
 * A transaction whose maxFeePerGas is below this floor can never be included,
 * because the base fee is not allowed to fall further.
 */
export const BASE_SEPOLIA_MIN_BASE_FEE_WEI = 5_000_000n;

/**
 * EIP-1559 changes the base fee by parentBaseFee/8. Once the parent is below
 * 8 wei that delta truncates to 0, so the base fee cannot fall below 7 wei.
 * A max fee under 7 wei cannot be included on Ethereum.
 */
export const EIP1559_PRACTICAL_MIN_BASE_FEE_WEI = 7n;

export const ETHEREUM_SEPOLIA_CHAIN_ID = 11_155_111;

/** 10% — the minimum bump Base documents for a same-nonce replacement. */
export const DEFAULT_REPLACEMENT_BUMP_BPS = 1_000n;

/** 1 gwei. High enough for Sepolia inclusion, low enough to bound the pool's worst case. */
export const DEFAULT_FEE_CAP_WEI = 1_000_000_000n;

/** Modest priority fee (0.001 gwei) used when the network suggestion would blow the cap. */
export const MODEST_PRIORITY_FEE_WEI = 1_000_000n;

export const TRANSFER_GAS = 21_000n;

export const DEFAULT_PAYMENT_WEI = 1n;

export const DEFAULT_DERIVATION_PATH = "polaris-base-sepolia";

/** Confirmed against NEAR docs and chainsig.js CONTRACT_ADDRESSES.TESTNET. */
export const DEFAULT_MPC_CONTRACT_ID = "v1.signer-prod.testnet";

export const DEFAULT_NEAR_RPC_URL = "https://rpc.testnet.near.org";

export const DEFAULT_BASE_RPC_URL = "https://sepolia.base.org";

/** Base documents this endpoint for eth_sendRawTransaction only. */
export const DEFAULT_BASE_SEQUENCER_URL = "https://sepolia-sequencer.base.org";

export const DEFAULT_PAYMENT_TO = "0x000000000000000000000000000000000000dEaD" as const;

export const DEFAULT_STUCK_WAIT_MS = 12_000;

export const DEFAULT_STUCK_POLL_MS = 2_000;

export const DEFAULT_RECEIPT_WAIT_MS = 90_000;

/** MPC signing on testnet commonly takes tens of seconds; the yield may take longer. */
export const DEFAULT_MPC_WAIT_MS = 180_000;
