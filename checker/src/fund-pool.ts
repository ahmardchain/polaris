import "./env.js";
import { openSession } from "./session.js";

const ONE_NEAR = 1_000_000_000_000_000_000_000n;

async function main(): Promise<void> {
  const amount = process.env.FUND_POOL_YOCTO
    ? BigInt(process.env.FUND_POOL_YOCTO)
    : ONE_NEAR;
  if (amount <= 0n) {
    throw new Error("FUND_POOL_YOCTO must be positive");
  }
  const session = await openSession();
  const before = await session.guarantee.getPool();
  console.log(`contract: ${session.guarantee.contractId}`);
  console.log(`pool before: ${before.poolBalance.toString()} yoctoNEAR`);
  const hash = await session.guarantee.fundPool(amount);
  const after = await session.guarantee.getPool();
  console.log(`fund tx: ${hash}`);
  console.log(`https://testnet.nearblocks.io/txns/${hash}`);
  console.log(`pool after: ${after.poolBalance.toString()} yoctoNEAR`);
  console.log(`free coverage: ${after.freeCoverage.toString()} yoctoNEAR`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
