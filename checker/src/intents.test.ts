import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildQuoteRequest, parseQuoteResponse, WNEAR_ASSET, BASE_USDC_ASSET } from "./intents.js";

describe("1-Click quote", () => {
  it("builds a dry quote by default and does not ask for a deposit address", () => {
    const request = buildQuoteRequest({
      originAsset: WNEAR_ASSET,
      destinationAsset: BASE_USDC_ASSET,
      amount: "100000000000000000000000",
      recipient: "0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6",
      refundTo: "polaris-d1-z7npttup.testnet",
      now: new Date("2026-11-05T09:00:00.000Z"),
    });
    assert.equal(request.dry, true);
    assert.equal(request.swapType, "EXACT_INPUT");
    assert.equal(request.originAsset, WNEAR_ASSET);
    assert.equal(request.destinationAsset, BASE_USDC_ASSET);
    assert.equal(request.deadline, "2026-11-05T09:10:00.000Z");
  });

  it("refuses a live quote unless explicitly allowed", () => {
    const previous = process.env.INTENTS_ALLOW_LIVE;
    delete process.env.INTENTS_ALLOW_LIVE;
    assert.throws(() =>
      buildQuoteRequest({
        dry: false,
        originAsset: WNEAR_ASSET,
        destinationAsset: BASE_USDC_ASSET,
        amount: "1",
        recipient: "0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6",
        refundTo: "polaris-d1-z7npttup.testnet",
      }),
    );
    if (previous === undefined) {
      delete process.env.INTENTS_ALLOW_LIVE;
    } else {
      process.env.INTENTS_ALLOW_LIVE = previous;
    }
  });

  it("parses a dry success without treating a missing deposit address as a failure", () => {
    const parsed = parseQuoteResponse("eth-usdc-to-base-usdc", {
      correlationId: "abc",
      quote: {
        amountIn: "1000000",
        amountInFormatted: "1",
        amountOut: "997398",
        amountOutFormatted: "0.997398",
        amountOutUsd: "0.997",
        timeEstimate: 47,
      },
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dry, true);
    assert.equal(parsed.depositAddress, null);
    assert.equal(parsed.amountOutFormatted, "0.997398");
  });

  it("parses the pair-unavailable error", () => {
    const parsed = parseQuoteResponse("wnear-to-base-usdc", {
      message: "Quoting for this pair is not available",
      correlationId: "nope",
    });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.depositAddress, null);
    assert.match(parsed.message, /not available/);
  });
});
