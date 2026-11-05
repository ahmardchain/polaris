/**
 * NEAR Intents 1-Click quotes for an optional claim payout.
 * `dry: true` is the default: the API returns amounts and does not issue a
 * deposit address. There is no Intents testnet. A live quote (`dry: false`)
 * is refused unless INTENTS_ALLOW_LIVE=true, and this repo does not send one.
 */

export const ONE_CLICK_QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";
export const WNEAR_ASSET = "nep141:wrap.near";
export const BASE_USDC_ASSET =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const ETH_USDC_ASSET =
  "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  deadline: string;
}

export interface ParsedQuote {
  dry: true;
  route: "wnear-to-base-usdc" | "eth-usdc-to-base-usdc";
  ok: boolean;
  message: string;
  amountIn?: string;
  amountInFormatted?: string;
  amountOut?: string;
  amountOutFormatted?: string;
  amountOutUsd?: string;
  timeEstimateSeconds?: number;
  depositAddress: string | null;
  correlationId?: string;
}

export function buildQuoteRequest(input: {
  dry?: boolean;
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  now?: Date;
}): QuoteRequest {
  const dry = input.dry !== false;
  if (!dry && process.env.INTENTS_ALLOW_LIVE !== "true") {
    throw new Error(
      "Refusing a live 1-Click quote. Set INTENTS_ALLOW_LIVE=true to ask for a deposit address. This repo's demos stay on dry:true.",
    );
  }
  const now = input.now ?? new Date();
  return {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: input.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: input.destinationAsset,
    amount: input.amount,
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  };
}

export function parseQuoteResponse(route: ParsedQuote["route"], body: unknown): ParsedQuote {
  const record = (body ?? {}) as {
    message?: string;
    correlationId?: string;
    quote?: {
      amountIn?: string;
      amountInFormatted?: string;
      amountOut?: string;
      amountOutFormatted?: string;
      amountOutUsd?: string;
      timeEstimate?: number;
      depositAddress?: string | null;
    };
  };
  if (!record.quote) {
    return {
      dry: true,
      route,
      ok: false,
      message: record.message ?? "1-Click quote failed",
      depositAddress: null,
      correlationId: record.correlationId,
    };
  }
  return {
    dry: true,
    route,
    ok: true,
    message: "dry quote; no deposit address and no swap",
    amountIn: record.quote.amountIn,
    amountInFormatted: record.quote.amountInFormatted,
    amountOut: record.quote.amountOut,
    amountOutFormatted: record.quote.amountOutFormatted,
    amountOutUsd: record.quote.amountOutUsd,
    timeEstimateSeconds: record.quote.timeEstimate,
    depositAddress: record.quote.depositAddress ?? null,
    correlationId: record.correlationId,
  };
}

export async function requestQuote(request: QuoteRequest): Promise<unknown> {
  const response = await fetch(ONE_CLICK_QUOTE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return response.json();
}

/** Quote a NEAR claim into Base USDC. If that pair is down, also quote 1 ETH USDC to Base USDC. */
export async function quoteClaimPayout(input: {
  coverageYocto: string;
  recipient: string;
  refundTo: string;
  now?: Date;
}): Promise<{ claim: ParsedQuote; example: ParsedQuote | null }> {
  const claimRequest = buildQuoteRequest({
    originAsset: WNEAR_ASSET,
    destinationAsset: BASE_USDC_ASSET,
    amount: input.coverageYocto,
    recipient: input.recipient,
    refundTo: input.refundTo,
    now: input.now,
  });
  const claim = parseQuoteResponse("wnear-to-base-usdc", await requestQuote(claimRequest));
  if (claim.ok) {
    return { claim, example: null };
  }
  const exampleRequest = buildQuoteRequest({
    originAsset: ETH_USDC_ASSET,
    destinationAsset: BASE_USDC_ASSET,
    amount: "1000000",
    recipient: input.recipient,
    refundTo: input.recipient,
    now: input.now,
  });
  const example = parseQuoteResponse("eth-usdc-to-base-usdc", await requestQuote(exampleRequest));
  return { claim, example };
}
