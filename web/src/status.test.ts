import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capAllows, nearToYocto, shownStatus, yoctoToNear } from "./status.ts";

describe("shownStatus", () => {
  it("keeps an open guarantee pending until a demo path says otherwise", () => {
    assert.equal(shownStatus({ chainStatus: "Open" }), "Pending");
    assert.equal(
      shownStatus({ chainStatus: "Open", demo: { underpriced: "0xabc" } }),
      "stuck",
    );
    assert.equal(
      shownStatus({
        chainStatus: "Open",
        demo: { underpriced: "0xabc", replacement: "0xdef" },
      }),
      "fee-bumped",
    );
  });

  it("uses the chain status after the contract settles", () => {
    assert.equal(
      shownStatus({
        chainStatus: "Delivered",
        demo: { underpriced: "0xabc", replacement: "0xdef" },
      }),
      "Delivered",
    );
    assert.equal(shownStatus({ chainStatus: "Claimed", demo: { underpriced: "0xabc" } }), "Claimed");
  });
});

describe("pool cap", () => {
  const premium = nearToYocto("0.1");
  const pool = nearToYocto("0.4");
  assert.ok(premium !== null && pool !== null);

  it("allows coverage that fits in the pool after the premium", () => {
    const coverage = nearToYocto("0.0002");
    assert.ok(coverage !== null);
    assert.equal(
      capAllows({ poolBalance: pool!, outstanding: 0n, premium: premium!, coverage }),
      true,
    );
  });

  it("refuses coverage the pool cannot pay", () => {
    const coverage = nearToYocto("1");
    assert.ok(coverage !== null);
    assert.equal(
      capAllows({ poolBalance: pool!, outstanding: 0n, premium: premium!, coverage }),
      false,
    );
  });
});

describe("yoctoToNear", () => {
  it("prints the recorded coverage", () => {
    assert.equal(yoctoToNear(200_000_000_000_000_000_000n), "0.0002");
    assert.equal(yoctoToNear(100_000_000_000_000_000_000_000n), "0.1");
  });
});
