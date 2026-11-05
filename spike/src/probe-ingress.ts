import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { loadConfig } from "./config.js";
import "./env.js";
import { classifyBroadcastError } from "./errors.js";
import { replacementFees, underpricedFees } from "./fees.js";
import { formatWei, printLines } from "./report.js";

/**
 * Live check that does not need a funded account.
 * A zero-balance key asks Base Sepolia to accept an underpriced EIP-1559
 * transaction and an includable one. The error text shows whether the node
 * rejects low maxFeePerGas before it rejects an empty balance.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const account = privateKeyToAccount(generatePrivateKey());
  const readClient = createPublicClient({
    chain: baseSepolia,
    transport: http(config.baseRpcUrl),
  });
  const block = await readClient.getBlock();
  const baseFee = block.baseFeePerGas;
  if (baseFee == null) {
    throw new Error("Base Sepolia block has no baseFeePerGas");
  }
  const low = underpricedFees(baseFee);
  const high = replacementFees({
    baseFee,
    stuck: low,
    feeCapWei: config.feeCapWei,
  });
  const lines = [
    "Polaris ingress probe (unfunded throwaway key, nothing is signed by NEAR)",
    `throwaway: ${account.address}`,
    `baseFee: ${formatWei(baseFee)}`,
    `underpriced.maxFeePerGas: ${formatWei(low.maxFeePerGas)}`,
    `includable.maxFeePerGas: ${formatWei(high.maxFeePerGas)}`,
  ];

  const endpoints = [
    ["sequencer", config.baseSequencerUrl],
    ["rpc", config.baseRpcUrl],
  ] as const;

  for (const [label, url] of endpoints) {
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(url),
    });
    for (const [name, fees] of [
      ["underpriced", low],
      ["includable", high],
    ] as const) {
      try {
        const hash = await wallet.sendTransaction({
          to: account.address,
          value: 0n,
          gas: 21_000n,
          nonce: 0,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        lines.push(`${label} ${name}: ACCEPTED ${hash}`);
      } catch (error) {
        const failure = classifyBroadcastError(error);
        lines.push(`${label} ${name}: ${failure.kind}`);
        lines.push(`${label} ${name} message: ${failure.message}`);
      }
    }
  }

  printLines(lines);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
