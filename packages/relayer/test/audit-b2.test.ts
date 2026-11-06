import { describe, expect, it } from "vitest";
import { QuietpayError } from "@quietpay/shared";
import { makeEnv, newOrder } from "./helpers.js";

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  return err instanceof QuietpayError ? err.code : err === null ? null : "non-quietpay-error";
}

// Backend audit B2.2 (R4): the router needs value > fee, so an order whose amount is not strictly
// greater than the relay fee must be refused when it is created, before anything can be broadcast.
describe("audit R4: amount must be strictly greater than the relay fee", () => {
  const FEE = 50_000n; // makeCfg relayFee, below the merchant's 100_000 cap

  it("refuses amount == fee and amount < fee with invalid_amount, and never touches the chain", async () => {
    const { svc, chain } = makeEnv();
    for (const amount of [FEE, FEE - 1n, 1n]) {
      expect(await codeOf(newOrder(svc, amount.toString()))).toBe("invalid_amount");
    }
    expect(chain.sent).toHaveLength(0);
  });

  it("accepts amount == fee + 1 and records the quoted fee on the order", async () => {
    const { svc } = makeEnv();
    const order = await newOrder(svc, (FEE + 1n).toString());
    expect(order.fee).toBe(FEE.toString());
    expect(BigInt(order.amount)).toBe(FEE + 1n);
  });

  it("uses the lower of the configured fee and the merchant's cap when checking", async () => {
    // Merchant cap 100_000, configured fee 150_000 -> effective fee 100_000, so 100_000 is refused and 100_001 passes.
    const { svc } = makeEnv({ relayFee: 150_000n });
    expect(await codeOf(newOrder(svc, "100000"))).toBe("invalid_amount");
    const order = await newOrder(svc, "100001");
    expect(order.fee).toBe("100000");
  });
});
