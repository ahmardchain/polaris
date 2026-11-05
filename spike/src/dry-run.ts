import { JsonRpcProvider } from "@near-js/providers";
import { contracts } from "chainsig.js";
import { getAddress } from "viem";
import {
  baseClients,
  deriveAndVerify,
  readBaseFee,
  suggestPriorityFee,
} from "./chain.js";
import { loadConfig } from "./config.js";
import "./env.js";
import { formatWei, printLines } from "./report.js";
import { assertSameNonceReplacement, buildPaymentPlan } from "./plan.js";

const ILLUSTRATIVE_ACCOUNT = "example.testnet";

async function main(): Promise<void> {
  const config = loadConfig();
  const { readClient } = baseClients(config);
  const predecessor = config.nearAccountId ?? ILLUSTRATIVE_ACCOUNT;
  const provider = new JsonRpcProvider({ url: config.nearRpcUrl });
  const contract = new contracts.ChainSignatureContract({
    networkId: "testnet",
    contractId: config.mpcContractId,
    fallbackRpcUrls: [config.nearRpcUrl],
  });

  const [baseFee, suggestedPriority, derived, chainId] = await Promise.all([
    readBaseFee(readClient),
    suggestPriorityFee(readClient),
    deriveAndVerify({
      contract,
      provider,
      mpcContractId: config.mpcContractId,
      predecessor,
      path: config.derivationPath,
      readClient,
    }),
    readClient.getChainId(),
  ]);

  if (chainId !== 84532) {
    throw new Error(`RPC chain id ${chainId} is not Base Sepolia (84532)`);
  }

  const nonce = config.nearAccountId
    ? await readClient.getTransactionCount({
        address: derived.address,
        blockTag: "latest",
      })
    : 0;
  const balance = config.nearAccountId
    ? await readClient.getBalance({ address: derived.address })
    : undefined;

  const plan = buildPaymentPlan({
    nonce,
    baseFee,
    feeCapWei: config.feeCapWei,
    to: config.paymentTo,
    value: config.paymentWei,
    bumpBps: config.bumpBps,
    suggestedPriorityFee: suggestedPriority,
  });
  assertSameNonceReplacement(plan);

  const lines = [
    "Polaris day-1 spike (dry run)",
    "broadcast: not sent",
    "mpcSign: not requested",
    `nearAccount: ${predecessor}${config.nearAccountId ? "" : " (illustrative; set NEAR_ACCOUNT_ID to derive your account)"}`,
    `derivationPath: ${config.derivationPath}`,
    `mpcContract: ${config.mpcContractId}`,
    `derivedAddress: ${derived.address}`,
    `derivationMatchesContract: true`,
    `contractDerivedKey: ${derived.contractPublicKey}`,
    `baseSepoliaChainId: ${chainId}`,
    `baseFee: ${formatWei(baseFee)}`,
    `suggestedPriorityFee: ${suggestedPriority === undefined ? "unavailable" : formatWei(suggestedPriority)}`,
    `feeCap: ${formatWei(config.feeCapWei)}`,
    `nonce: ${plan.nonce}`,
    `nonceEqual: true`,
    `paymentTo: ${getAddress(config.paymentTo)}`,
    `paymentWei: ${config.paymentWei.toString()}`,
    `underpriced.maxFeePerGas: ${formatWei(plan.underpriced.maxFeePerGas)}`,
    `underpriced.maxPriorityFeePerGas: ${formatWei(plan.underpriced.maxPriorityFeePerGas)}`,
    `replacement.maxFeePerGas: ${formatWei(plan.replacement.maxFeePerGas)}`,
    `replacement.maxPriorityFeePerGas: ${formatWei(plan.replacement.maxPriorityFeePerGas)}`,
    `balance: ${balance === undefined ? "skipped (no NEAR_ACCOUNT_ID)" : `${balance.toString()} wei`}`,
  ];

  if (balance !== undefined) {
    const worstCase = config.paymentWei + plan.replacement.gas * plan.replacement.maxFeePerGas;
    if (balance < worstCase) {
      lines.push(
        `note: derived address balance is below value + gas * replacement maxFee (${worstCase.toString()} wei). Fund ${derived.address} from a Base Sepolia faucet before npm run spike. Base also charges an L1 data fee on top of that L2 max.`,
      );
    }
  }
  lines.push("result: dry-run");
  printLines(lines);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
