export type BroadcastFailureKind =
  | "below_base_fee"
  | "replacement_underpriced"
  | "underpriced"
  | "insufficient_funds"
  | "nonce_too_low"
  | "already_known"
  | "other";

export interface BroadcastFailure {
  kind: BroadcastFailureKind;
  message: string;
}

const RPC_REASON =
  /max fee per gas less than block base fee|replacement transaction underpriced|insufficient funds|nonce too low|already known|underpriced/i;

function collectMessages(error: unknown, depth: number, out: string[]): void {
  if (depth > 6 || error == null) {
    return;
  }
  if (typeof error === "string") {
    if (error.length > 0 && error.length < 500) {
      out.push(error);
    }
    return;
  }
  if (typeof error !== "object") {
    return;
  }
  const extra = error as {
    shortMessage?: unknown;
    details?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  for (const part of [extra.details, extra.shortMessage, extra.message]) {
    if (typeof part === "string" && part.length > 0 && part.length < 500) {
      out.push(part);
    }
  }
  collectMessages(extra.cause, depth + 1, out);
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  collectMessages(error, 0, parts);
  return parts.find((part) => RPC_REASON.test(part)) ?? parts[0] ?? "unknown broadcast error";
}

/**
 * Classify an eth_sendRawTransaction failure.
 * Replacement-underpriced is matched before the generic underpriced substring.
 */
export function classifyBroadcastError(error: unknown): BroadcastFailure {
  const message = errorText(error) || "unknown broadcast error";
  const lower = message.toLowerCase();
  if (
    lower.includes("max fee per gas less than block base fee") ||
    lower.includes("feecaptoolow")
  ) {
    return { kind: "below_base_fee", message };
  }
  if (lower.includes("replacement transaction underpriced")) {
    return { kind: "replacement_underpriced", message };
  }
  if (lower.includes("underpriced")) {
    return { kind: "underpriced", message };
  }
  if (lower.includes("insufficient funds")) {
    return { kind: "insufficient_funds", message };
  }
  if (lower.includes("nonce too low")) {
    return { kind: "nonce_too_low", message };
  }
  if (lower.includes("already known")) {
    return { kind: "already_known", message };
  }
  return { kind: "other", message };
}

export function isIngressFeeRejection(kind: BroadcastFailureKind): boolean {
  return kind === "below_base_fee" || kind === "underpriced";
}
