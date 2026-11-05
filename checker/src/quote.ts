import "./env.js";
import { quoteClaimPayout } from "./intents.js";

const coverage = process.env.COVERAGE_YOCTO ?? "200000000000000000000";
const recipient = process.env.INTENTS_RECIPIENT ?? "0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6";
const refundTo = process.env.NEAR_ACCOUNT_ID ?? "polaris-d1-z7npttup.testnet";

const quotes = await quoteClaimPayout({
  coverageYocto: coverage,
  recipient,
  refundTo,
});
console.log(JSON.stringify(quotes, null, 2));
if (!quotes.claim.ok && !quotes.example?.ok) {
  process.exitCode = 1;
}
