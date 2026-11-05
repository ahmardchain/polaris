import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observeTransaction, type TxPhase } from "./observe.js";

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("observeTransaction", () => {
  it("returns as soon as the transaction is mined and remembers that it was pending", async () => {
    const time = clock();
    const script: TxPhase[] = ["pending", "pending", "mined"];
    const observation = await observeTransaction({
      waitMs: 12_000,
      pollMs: 2_000,
      now: time.now,
      sleep: time.sleep,
      lookup: async () => script.shift() ?? "mined",
    });
    assert.equal(observation.phase, "mined");
    assert.equal(observation.sawPending, true);
    assert.ok(observation.elapsedMs < 12_000);
  });

  it("reports pending when the transaction is still unmined after the wait", async () => {
    const time = clock();
    const observation = await observeTransaction({
      waitMs: 6_000,
      pollMs: 2_000,
      now: time.now,
      sleep: time.sleep,
      lookup: async () => "pending",
    });
    assert.deepEqual(observation, {
      phase: "pending",
      sawPending: true,
      elapsedMs: 6_000,
    });
  });

  it("reports absent when the node never shows the transaction", async () => {
    const time = clock();
    const observation = await observeTransaction({
      waitMs: 4_000,
      pollMs: 2_000,
      now: time.now,
      sleep: time.sleep,
      lookup: async () => "absent",
    });
    assert.equal(observation.phase, "absent");
    assert.equal(observation.sawPending, false);
    assert.equal(observation.elapsedMs, 4_000);
  });
});
