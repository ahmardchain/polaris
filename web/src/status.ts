export type ChainStatus = "Open" | "Delivered" | "Claimed";
export type ShownStatus = "Pending" | "stuck" | "fee-bumped" | "Delivered" | "Claimed";

export interface DemoPath {
  underpriced?: string;
  replacement?: string;
}

/** Live badge. Chain status wins once the contract has settled the guarantee. */
export function shownStatus(input: {
  chainStatus: ChainStatus;
  demo?: DemoPath;
}): ShownStatus {
  if (input.chainStatus === "Delivered") return "Delivered";
  if (input.chainStatus === "Claimed") return "Claimed";
  if (input.demo?.replacement) return "fee-bumped";
  if (input.demo?.underpriced) return "stuck";
  return "Pending";
}

/** True when outstanding + coverage would exceed the pool after the premium is added. */
export function capAllows(input: {
  poolBalance: bigint;
  outstanding: bigint;
  premium: bigint;
  coverage: bigint;
}): boolean {
  return input.outstanding + input.coverage <= input.poolBalance + input.premium;
}

export function nearToYocto(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(trimmed)) {
    return null;
  }
  const [whole, frac = ""] = trimmed.split(".");
  const padded = `${frac}${"0".repeat(24)}`.slice(0, 24);
  return BigInt(whole) * 10n ** 24n + BigInt(padded);
}

export function yoctoToNear(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** 24n;
  const frac = (abs % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  const text = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${text}` : text;
}
