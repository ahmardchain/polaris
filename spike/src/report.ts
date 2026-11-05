export function formatWei(wei: bigint): string {
  const sign = wei < 0n ? "-" : "";
  const abs = wei < 0n ? -wei : wei;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  const gwei = frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
  return `${sign}${abs.toString()} wei (${sign}${gwei} gwei)`;
}

export function printLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}
