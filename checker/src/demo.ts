import "./env.js";
import { quoteClaimPayout } from "./intents.js";
import { openSession, type Session } from "./session.js";
import { claimIfStillOpen, runGuaranteedPayment, type RunReport } from "./service.js";

const ONE_NEAR = 1_000_000_000_000_000_000_000n;
const COVERAGE = process.env.COVERAGE_YOCTO
  ? BigInt(process.env.COVERAGE_YOCTO)
  : 200_000_000_000_000_000_000n;
const FUND = process.env.FUND_POOL_YOCTO ? BigInt(process.env.FUND_POOL_YOCTO) : ONE_NEAR;

async function main(): Promise<void> {
  const which = process.argv[2] ?? "both";
  if (which !== "a" && which !== "b" && which !== "both") {
    throw new Error("usage: tsx src/demo.ts [a|b|both]");
  }
  const session = await openSession();
  console.log(`checker contract: ${session.guarantee.contractId}`);
  console.log(`evm from: ${session.from} on ${session.chainName} (${session.chainId})`);
  await ensurePool(session);

  const reports: Record<string, unknown> = {};
  if (which === "a" || which === "both") {
    reports.a = await scenarioRescued(session);
  }
  if (which === "b" || which === "both") {
    reports.b = await scenarioTimeout(session);
  }
  console.log("DEMO_JSON");
  console.log(JSON.stringify(reports, replacer, 2));
}

async function ensurePool(session: Session): Promise<void> {
  const pool = await session.guarantee.getPool();
  const needed = COVERAGE * 2n;
  if (pool.freeCoverage >= needed) {
    console.log(`pool free coverage ${pool.freeCoverage} covers ${needed}; not funding`);
    return;
  }
  console.log(`funding pool with ${FUND} yoctoNEAR`);
  const hash = await session.guarantee.fundPool(FUND);
  const after = await session.guarantee.getPool();
  console.log(`fund tx: ${hash}`);
  console.log(`https://testnet.nearblocks.io/txns/${hash}`);
  console.log(`pool balance now ${after.poolBalance}`);
}

async function scenarioRescued(session: Session): Promise<RunReport> {
  const now = await session.guarantee.nowNs();
  const deadlineNs = now + 20n * 60n * 1_000_000_000n;
  console.log("scenario A: stuck payment, fee bump, then proof");
  const report = await runGuaranteedPayment({
    near: session.guarantee,
    evm: session.evm,
    request: common(session, deadlineNs),
    sleep,
    onDecision: (decision, at) => console.log(`A ${at} ${decision.type} ${decision.reason ?? ""}`),
    quotePayout: () => payoutQuote(session),
  });
  printReport("A", report);
  if (report.outcome !== "proved") {
    throw new Error(`scenario A left the guarantee open: ${report.reason}`);
  }
  return report;
}

async function scenarioTimeout(session: Session): Promise<unknown> {
  const now = await session.guarantee.nowNs();
  const deadlineNs = now + 120n * 1_000_000_000n;
  console.log("scenario B: deadline passes while the payment is still stuck; claim refunds the agent");
  const report = await runGuaranteedPayment({
    near: session.guarantee,
    evm: session.evm,
    request: common(session, deadlineNs),
    sleep,
    onDecision: (decision, at) => console.log(`B ${at} ${decision.type} ${decision.reason ?? ""}`),
    quotePayout: () => payoutQuote(session),
  });
  printReport("B", report);
  if (report.outcome !== "left_for_claim") {
    throw new Error("scenario B proved delivery; the deadline was long enough to rescue it");
  }

  let claimTx: string | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const nearNow = await session.guarantee.nowNs();
    if (nearNow < deadlineNs) {
      await sleep(3_000);
      continue;
    }
    try {
      const claimed = await claimIfStillOpen(session.guarantee, report.guaranteeId);
      claimTx = claimed.nearTxHash;
      console.log(`B claim status ${claimed.status} tx ${claimed.nearTxHash}`);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("deadline has not passed")) {
        throw error;
      }
      await sleep(3_000);
    }
  }
  if (!claimTx) {
    throw new Error("scenario B did not claim");
  }

  const view = await session.guarantee.getGuarantee(report.guaranteeId);
  const pool = await session.guarantee.getPool();
  let recovery: { hash: string } | null = null;
  const nonceNow = await session.evm.getNonce();
  if (report.underpriced && nonceNow === report.nonce) {
    console.log("B clearing the stuck nonce with a replacement that is not submitted as proof");
    const sent = await session.evm.sendReplacement(report.nonce);
    if (!sent.ok) {
      throw new Error(`nonce recovery failed: ${sent.reason}`);
    }
    recovery = { hash: sent.hash };
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      const tx = await session.evm.getTx(sent.hash);
      if (tx.status === "mined") {
        break;
      }
      await sleep(4_000);
    }
  }

  return {
    ...report,
    claimTxHash: claimTx,
    claimStatus: view?.status ?? null,
    poolBalanceAfter: pool.poolBalance.toString(),
    nonceRecoveryHash: recovery?.hash ?? null,
    nonceRecoveryNote:
      "Same-nonce transfer after claim, only to free the EVM account. submit_proof was not called.",
  };
}

function common(session: Session, deadlineNs: bigint) {
  return {
    destinationChain: "ethereum-sepolia",
    recipient: session.paymentTo,
    amount: session.paymentWei,
    coverage: COVERAGE,
    deadlineNs,
    requiredConfirmations: Number(process.env.REQUIRED_CONFIRMATIONS ?? 2),
    stuckAfterMs: Number(process.env.STUCK_AFTER_MS ?? 24_000),
    rescueBudgetMs: Number(process.env.RESCUE_BUDGET_MS ?? 180_000),
    msPerConfirmation: 15_000,
    feeCapWei: session.feeCapWei,
    pollMs: 4_000,
  };
}

function printReport(label: string, report: RunReport): void {
  console.log(`${label} guarantee ${report.guaranteeId} buy ${report.buyTxHash}`);
  console.log(`${label} https://testnet.nearblocks.io/txns/${report.buyTxHash}`);
  if (report.underpriced) {
    console.log(`${label} underpriced ${report.underpriced.hash} mpcMs ${report.underpriced.mpcMs}`);
    console.log(`${label} https://sepolia.etherscan.io/tx/${report.underpriced.hash}`);
  }
  if (report.replacement) {
    console.log(`${label} replacement ${report.replacement.hash} mpcMs ${report.replacement.mpcMs}`);
    console.log(`${label} https://sepolia.etherscan.io/tx/${report.replacement.hash}`);
  }
  if (report.proofTxHash) {
    console.log(`${label} proof ${report.proofTxHash}`);
    console.log(`${label} https://testnet.nearblocks.io/txns/${report.proofTxHash}`);
  }
  console.log(`${label} outcome ${report.outcome} pendingForMs ${report.pendingForMs} sawPending ${report.sawPending}`);
}

function payoutQuote(session: Session) {
  return quoteClaimPayout({
    coverageYocto: COVERAGE.toString(),
    recipient: session.paymentTo,
    refundTo: process.env.NEAR_ACCOUNT_ID ?? "polaris-d1-z7npttup.testnet",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
