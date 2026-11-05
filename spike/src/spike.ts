import { type Address, type Hash, type Hex } from "viem";
import {
  baseClients,
  broadcastSigned,
  connectNear,
  deriveAndVerify,
  readBaseFee,
  signPayment,
  suggestPriorityFee,
  type BaseClient,
  type SignedPayment,
} from "./chain.js";
import { loadConfig, requireSigner } from "./config.js";
import "./env.js";
import { isIngressFeeRejection, type BroadcastFailureKind } from "./errors.js";
import { FeeCapExceededError } from "./fees.js";
import { observeTransaction, type TxPhase } from "./observe.js";
import { assertSameNonceReplacement, buildPaymentPlan, type PaymentPlan } from "./plan.js";
import { formatWei, printLines } from "./report.js";

async function phaseOf(client: BaseClient, hash: Hash): Promise<TxPhase> {
  const receipt = await client
    .getTransactionReceipt({ hash })
    .catch(() => null);
  if (receipt) {
    return "mined";
  }
  const tx = await client.getTransaction({ hash }).catch(() => null);
  if (tx && tx.blockNumber == null) {
    return "pending";
  }
  if (tx && tx.blockNumber != null) {
    return "mined";
  }
  return "absent";
}

/** Pending state is often visible only on the endpoint that accepted the raw transaction. */
async function phaseOfEither(
  readClient: BaseClient,
  sequencerClient: BaseClient,
  hash: Hash,
): Promise<TxPhase> {
  const [fromRead, fromSequencer] = await Promise.all([
    phaseOf(readClient, hash),
    phaseOf(sequencerClient, hash),
  ]);
  if (fromRead === "mined" || fromSequencer === "mined") {
    return "mined";
  }
  if (fromRead === "pending" || fromSequencer === "pending") {
    return "pending";
  }
  return "absent";
}

function ingressRejected(kind: string): boolean {
  const parts = kind.split(",").map((part) => part.trim().replace(/^then /, ""));
  return parts.some(
    (part) =>
      part === "below_base_fee" ||
      part === "underpriced" ||
      isIngressFeeRejection(part as BroadcastFailureKind),
  );
}

async function broadcastWithFallback(
  sequencer: BaseClient,
  readRpc: BaseClient,
  sameEndpoint: boolean,
  serialized: Hex,
): Promise<{ ok: true; hash: Hash; via: string } | { ok: false; message: string; kind: string }> {
  const first = await broadcastSigned(sequencer, serialized);
  if (first.ok) {
    return { ok: true, hash: first.hash, via: "sequencer" };
  }
  const retryOnRpc =
    !sameEndpoint &&
    (isIngressFeeRejection(first.failure.kind) || first.failure.kind === "other");
  if (!retryOnRpc) {
    return { ok: false, message: first.failure.message, kind: first.failure.kind };
  }
  const second = await broadcastSigned(readRpc, serialized);
  if (second.ok) {
    return { ok: true, hash: second.hash, via: "rpc-after-sequencer-reject" };
  }
  return {
    ok: false,
    kind: `${first.failure.kind}, then ${second.failure.kind}`,
    message: `sequencer: ${first.failure.message} || rpc: ${second.failure.message}`,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const signer = requireSigner(config);
  const { readClient, sequencerClient } = baseClients(config);
  const near = await connectNear(config, signer.nearAccountId, signer.nearPrivateKey);
  const derived = await deriveAndVerify({
    contract: near.contract,
    provider: near.provider,
    mpcContractId: config.mpcContractId,
    predecessor: signer.nearAccountId,
    path: config.derivationPath,
    readClient,
  });

  const chainId = await readClient.getChainId();
  if (chainId !== 84532) {
    throw new Error(`RPC chain id ${chainId} is not Base Sepolia (84532)`);
  }

  const [baseFee, suggestedPriority, nonce, balance, nearState] = await Promise.all([
    readBaseFee(readClient),
    suggestPriorityFee(readClient),
    readClient.getTransactionCount({ address: derived.address, blockTag: "latest" }),
    readClient.getBalance({ address: derived.address }),
    near.account.getState(),
  ]);

  let plan: PaymentPlan;
  try {
    plan = buildPaymentPlan({
      nonce,
      baseFee,
      feeCapWei: config.feeCapWei,
      to: config.paymentTo,
      value: config.paymentWei,
      bumpBps: config.bumpBps,
      suggestedPriorityFee: suggestedPriority,
    });
    assertSameNonceReplacement(plan);
  } catch (error) {
    if (error instanceof FeeCapExceededError) {
      printLines([
        "Polaris day-1 spike",
        "result: fee-cap",
        error.message,
      ]);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const worstCase = config.paymentWei + plan.replacement.gas * plan.replacement.maxFeePerGas;
  const nearBalance = nearState.balance.available;
  const lines = [
    "Polaris day-1 spike",
    `nearAccount: ${signer.nearAccountId}`,
    `nearBalanceYocto: ${nearBalance.toString()}`,
    `derivationPath: ${config.derivationPath}`,
    `mpcContract: ${config.mpcContractId}`,
    `derivedAddress: ${derived.address}`,
    `derivationMatchesContract: true`,
    `baseFee: ${formatWei(baseFee)}`,
    `suggestedPriorityFee: ${suggestedPriority === undefined ? "unavailable" : formatWei(suggestedPriority)}`,
    `feeCap: ${formatWei(config.feeCapWei)}`,
    `nonce: ${plan.nonce}`,
    `balanceWei: ${balance.toString()}`,
    `underpriced.maxFeePerGas: ${formatWei(plan.underpriced.maxFeePerGas)}`,
    `underpriced.maxPriorityFeePerGas: ${formatWei(plan.underpriced.maxPriorityFeePerGas)}`,
    `replacement.maxFeePerGas: ${formatWei(plan.replacement.maxFeePerGas)}`,
    `replacement.maxPriorityFeePerGas: ${formatWei(plan.replacement.maxPriorityFeePerGas)}`,
  ];

  if (nearBalance < 50_000_000_000_000_000_000_000n) {
    lines.push(
      "result: near-unfunded",
      "note: the NEAR account has under 0.05 NEAR. Two MPC sign calls need gas. Fund it from https://near.org/faucet or the testnet helper, then rerun.",
    );
    printLines(lines);
    process.exitCode = 1;
    return;
  }
  if (balance < worstCase) {
    lines.push(
      "result: evm-unfunded",
      `note: ${derived.address} has ${balance.toString()} wei. The replacement can cost up to ${worstCase.toString()} wei of L2 gas, plus Base's L1 data fee.`,
      "note: fund that address from a Base Sepolia faucet (Coinbase CDP, Alchemy, QuickNode, or https://ethfaucet.com/networks/base/base-sepolia), wait for the drip, then rerun npm run spike.",
    );
    printLines(lines);
    process.exitCode = 1;
    return;
  }

  console.log(`Signing underpriced payment via ${config.mpcContractId}. MPC yield can take a minute or two.`);
  const underpriced = await signPayment({
    readClient,
    contract: near.contract,
    signerAccount: near.signerAccount,
    path: config.derivationPath,
    from: derived.address,
    payment: plan.underpriced,
  });
  lines.push(`underpriced.localHash: ${underpriced.hash}`);
  lines.push(`underpriced.mpcMs: ${underpriced.mpcMs}`);
  lines.push(`underpriced.signedNonce: ${underpriced.nonce}`);

  const sameEndpoint = config.baseRpcUrl === config.baseSequencerUrl;
  const sentUnder = await broadcastWithFallback(
    sequencerClient,
    readClient,
    sameEndpoint,
    underpriced.serialized,
  );

  if (!sentUnder.ok) {
    lines.push(`underpriced.broadcast: rejected`);
    lines.push(`underpriced.reject: ${sentUnder.kind}: ${sentUnder.message}`);
    if (!ingressRejected(sentUnder.kind)) {
      lines.push("result: broadcast-rejected");
      lines.push("note: the underpriced transaction was rejected for a reason other than the fee. No replacement was broadcast.");
      printLines(lines);
      process.exitCode = 1;
      return;
    }
    await landFallback(lines, {
      configPath: config.derivationPath,
      readClient,
      sequencerClient,
      sameEndpoint,
      near,
      from: derived.address,
      plan,
      reason:
        "The Base endpoint rejected the underpriced transaction at ingress, so it never sat in the mempool. Fallback: sign and broadcast only the fee-bumped transaction at the same nonce.",
      receiptWaitMs: config.receiptWaitMs,
    });
    return;
  }

  lines.push(`underpriced.broadcast: accepted via ${sentUnder.via}`);
  lines.push(`underpriced.hash: ${sentUnder.hash}`);
  if (sentUnder.hash.toLowerCase() !== underpriced.hash.toLowerCase()) {
    lines.push(`note: node hash ${sentUnder.hash} differs from local keccak ${underpriced.hash}`);
  }

  console.log(`Waiting ${config.stuckWaitMs}ms to see whether the underpriced transaction stays pending.`);
  const stuck = await observeTransaction({
    waitMs: config.stuckWaitMs,
    pollMs: config.stuckPollMs,
    lookup: () => phaseOfEither(readClient, sequencerClient, sentUnder.hash),
  });
  lines.push(`underpriced.observation: ${stuck.phase}`);
  lines.push(`underpriced.sawPending: ${stuck.sawPending}`);
  lines.push(`underpriced.observedMs: ${stuck.elapsedMs}`);

  if (stuck.phase === "mined") {
    lines.push("result: underpriced-mined");
    lines.push(
      "note: the underpriced transaction was included. It did not stay stuck, so no replacement was sent. Raise the gap between maxFeePerGas and the base fee, or the node is not enforcing the minimum base fee.",
    );
    printLines(lines);
    process.exitCode = 1;
    return;
  }

  const stillBelow = plan.underpriced.maxFeePerGas < (await readBaseFee(readClient));
  if (!stillBelow) {
    lines.push("result: base-fee-dropped");
    lines.push("note: the base fee fell to the stuck max fee before replacement. Not sending a replacement that may no longer be required.");
    printLines(lines);
    process.exitCode = 1;
    return;
  }

  console.log("Underpriced transaction is unmined. Signing the same-nonce replacement.");
  const replacement = await signPayment({
    readClient,
    contract: near.contract,
    signerAccount: near.signerAccount,
    path: config.derivationPath,
    from: derived.address,
    payment: plan.replacement,
  });
  lines.push(`replacement.localHash: ${replacement.hash}`);
  lines.push(`replacement.mpcMs: ${replacement.mpcMs}`);
  lines.push(`replacement.signedNonce: ${replacement.nonce}`);
  lines.push(`nonceEqual: ${replacement.nonce === underpriced.nonce}`);

  if (replacement.nonce !== underpriced.nonce) {
    lines.push("result: nonce-mismatch");
    printLines(lines);
    process.exitCode = 1;
    return;
  }

  const originalNow = await phaseOfEither(readClient, sequencerClient, sentUnder.hash);
  if (originalNow === "mined") {
    lines.push("result: underpriced-mined-during-mpc");
    lines.push("note: the first transaction was included while the replacement was being signed. The replacement was not broadcast.");
    printLines(lines);
    process.exitCode = 1;
    return;
  }

  const sentReplacement = await broadcastWithFallback(
    sequencerClient,
    readClient,
    sameEndpoint,
    replacement.serialized,
  );
  if (!sentReplacement.ok) {
    lines.push(`replacement.broadcast: rejected`);
    lines.push(`replacement.reject: ${sentReplacement.kind}: ${sentReplacement.message}`);
    lines.push("result: replacement-rejected");
    printLines(lines);
    process.exitCode = 1;
    return;
  }
  lines.push(`replacement.broadcast: accepted via ${sentReplacement.via}`);
  lines.push(`replacement.hash: ${sentReplacement.hash}`);

  const landed = await observeTransaction({
    waitMs: config.receiptWaitMs,
    pollMs: config.stuckPollMs,
    lookup: () => phaseOfEither(readClient, sequencerClient, sentReplacement.hash),
  });
  lines.push(`replacement.observation: ${landed.phase}`);
  if (landed.phase !== "mined") {
    lines.push("result: replacement-pending");
    lines.push("note: the replacement was accepted but had no receipt before RECEIPT_WAIT_MS. Inspect the hash on https://sepolia.basescan.org.");
    printLines(lines);
    process.exitCode = 1;
    return;
  }

  const receipt = await readClient.getTransactionReceipt({ hash: sentReplacement.hash });
  const originalReceipt = await readClient.getTransactionReceipt({ hash: sentUnder.hash }).catch(() => null);
  lines.push(`replacement.status: ${receipt.status}`);
  lines.push(`replacement.block: ${receipt.blockNumber.toString()}`);
  lines.push(`underpriced.mined: ${originalReceipt ? "yes" : "no"}`);
  if (receipt.status !== "success") {
    lines.push("result: replacement-reverted");
    printLines(lines);
    process.exitCode = 1;
    return;
  }
  if (originalReceipt && originalReceipt.status === "success") {
    lines.push("result: both-mined");
    lines.push("note: both hashes have success receipts. That should be impossible for one nonce; inspect them before trusting the spike.");
    printLines(lines);
    process.exitCode = 1;
    return;
  }

  lines.push(
    stuck.sawPending
      ? "result: replaced"
      : "result: fallback-original-not-visible",
  );
  if (!stuck.sawPending) {
    lines.push(
      "note: eth_sendRawTransaction accepted the underpriced hash, but the read RPC never returned it as pending. The higher-fee transaction at the same nonce mined. This still shows same-nonce fee bumping, with weaker evidence that the first transaction sat in a mempool.",
    );
  }
  printLines(lines);
}

async function landFallback(
  lines: string[],
  input: {
    configPath: string;
    readClient: BaseClient;
    sequencerClient: BaseClient;
    sameEndpoint: boolean;
    near: Awaited<ReturnType<typeof connectNear>>;
    from: Address;
    plan: PaymentPlan;
    reason: string;
    receiptWaitMs: number;
  },
): Promise<void> {
  lines.push(`fallback: ${input.reason}`);
  console.log(input.reason);
  const replacement: SignedPayment = await signPayment({
    readClient: input.readClient,
    contract: input.near.contract,
    signerAccount: input.near.signerAccount,
    path: input.configPath,
    from: input.from,
    payment: input.plan.replacement,
  });
  lines.push(`replacement.localHash: ${replacement.hash}`);
  lines.push(`replacement.mpcMs: ${replacement.mpcMs}`);
  lines.push(`replacement.signedNonce: ${replacement.nonce}`);
  lines.push(`nonceEqual: ${replacement.nonce === input.plan.nonce}`);
  const sent = await broadcastWithFallback(
    input.sequencerClient,
    input.readClient,
    input.sameEndpoint,
    replacement.serialized,
  );
  if (!sent.ok) {
    lines.push(`replacement.broadcast: rejected`);
    lines.push(`replacement.reject: ${sent.kind}: ${sent.message}`);
    lines.push("result: fallback-rejected");
    printLines(lines);
    process.exitCode = 1;
    return;
  }
  lines.push(`replacement.broadcast: accepted via ${sent.via}`);
  lines.push(`replacement.hash: ${sent.hash}`);
  const landed = await observeTransaction({
    waitMs: input.receiptWaitMs,
    pollMs: 2_000,
    lookup: () => phaseOfEither(input.readClient, input.sequencerClient, sent.hash),
  });
  lines.push(`replacement.observation: ${landed.phase}`);
  if (landed.phase !== "mined") {
    lines.push("result: fallback-pending");
    printLines(lines);
    process.exitCode = 1;
    return;
  }
  const receipt = await input.readClient.getTransactionReceipt({ hash: sent.hash });
  lines.push(`replacement.status: ${receipt.status}`);
  lines.push(`replacement.block: ${receipt.blockNumber.toString()}`);
  lines.push(receipt.status === "success" ? "result: fallback-ingress-rejected" : "result: fallback-reverted");
  if (receipt.status !== "success") {
    process.exitCode = 1;
  }
  printLines(lines);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
