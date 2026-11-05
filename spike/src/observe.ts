export type TxPhase = "pending" | "mined" | "absent";

export interface Observation {
  phase: TxPhase;
  sawPending: boolean;
  elapsedMs: number;
}

export async function observeTransaction(options: {
  waitMs: number;
  pollMs: number;
  lookup: () => Promise<TxPhase>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Observation> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (options.waitMs < 0 || options.pollMs <= 0) {
    throw new Error("waitMs must be >= 0 and pollMs must be > 0");
  }

  const started = now();
  let sawPending = false;
  let phase: TxPhase = "absent";

  for (;;) {
    phase = await options.lookup();
    if (phase === "pending") {
      sawPending = true;
    }
    if (phase === "mined") {
      return { phase, sawPending, elapsedMs: now() - started };
    }
    const elapsed = now() - started;
    if (elapsed >= options.waitMs) {
      return { phase, sawPending, elapsedMs: elapsed };
    }
    const remaining = options.waitMs - elapsed;
    await sleep(Math.min(options.pollMs, remaining));
  }
}
