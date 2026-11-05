/** Recorded checker demo. Live chain status is loaded separately and wins once settled. */
export interface RecordedGuarantee {
  id: number;
  scenario: "A" | "B";
  title: string;
  pendingMs: number;
  mpcUnderpricedMs: number;
  mpcReplacementMs: number | null;
  buyTx: string;
  underpricedTx: string;
  replacementTx: string | null;
  proofTx: string | null;
  claimTx: string | null;
  nonceRecoveryTx: string | null;
  note: string;
}

export const CONTRACT_ID = "guarantee.polaris-d1-z7npttup.testnet";

export const recorded: RecordedGuarantee[] = [
  {
    id: 3,
    scenario: "A",
    title: "Stuck payment, fee-bumped, proof submitted",
    pendingMs: 28449,
    mpcUnderpricedMs: 26792,
    mpcReplacementMs: 16210,
    buyTx: "4dCwev8mrQaZtV5q1Pz5wTjFPsryxf17r8Rm2Z2LUo3E",
    underpricedTx: "0x2e73d90c91a00fecf935a78f04b92164ba36591e1db04617c01a6d210774085b",
    replacementTx: "0x4546eed3b02239a3bea9646ea3ddf59b8b82787d726effe92662c8bd67e5ba9e",
    proofTx: "4m8SUbbX7dW2mbBpUyzGYsrGxNNDN568CQoHRaJC1mfZ",
    claimTx: null,
    nonceRecoveryTx: null,
    note: "Nonce 3. Underpriced maxFeePerGas was 3 wei and sat pending. The replacement mined in block 12067942 with 2 confirmations.",
  },
  {
    id: 4,
    scenario: "B",
    title: "Deadline passed, claim paid the agent",
    pendingMs: 84141,
    mpcUnderpricedMs: 15605,
    mpcReplacementMs: null,
    buyTx: "GF3AVqCDHHYhrVjnoD6Ewq5AuMwEKeHZiDAxwPPnQcLM",
    underpricedTx: "0x03cc5ec7c877007e020e507ad838bd76f704538d87ff5d983aa6d783265ac2d9",
    replacementTx: null,
    proofTx: null,
    claimTx: "5onvRo1TirhoLTW9NY9adyyGqXxxMame9QdkMkSoEcfi",
    nonceRecoveryTx: "0xbee7cb84d992c61e5379dd60dad9ab488e35f0c9b385774cc45b201a093908ab",
    note: "Nonce 4 stayed pending for 84.1s. No proof was submitted. Claim paid 0.0002 NEAR. The recovery transfer only freed the nonce.",
  },
];

export function sepoliaTx(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

export function nearTx(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}
