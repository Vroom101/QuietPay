import { describe, expect, it } from "vitest";
import { MERCHANT_ID, makeEnv, newOrder, signFor } from "./helpers.js";

// Each test pins behaviour that a mutation run showed no test was guarding (docs/b/mutation-results.md).
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "other";
  }
};

describe("mutation kills: relayer", () => {
  it("R1: an approval that expires exactly now is order_expired (not a generic bad_signature)", async () => {
    const { svc, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t, { validBefore: clock.t });
    expect(await codeOf(svc.relayPay(req, { ip: "1.1.1.1" }))).toBe("order_expired");
  });

  it("R12: an order that is already partially refunded or refunded cannot be paid again", async () => {
    for (const status of ["partially_refunded", "refunded"]) {
      const { svc, db, clock } = makeEnv();
      const order = await newOrder(svc);
      db.raw.prepare("UPDATE orders SET status=? WHERE id=?").run(status, order.id);
      const req = await signFor(order, clock.t);
      expect(await codeOf(svc.relayPay(req, { ip: "1.1.1.1" })), status).toBe("already_settled");
    }
  });

  it("R7: one wallet hammering one order from many addresses is rate limited per order", async () => {
    const { svc, clock, cfg } = makeEnv();
    svc.setLocalPaused(true); // every attempt gets past the per-order check and is then refused without changing state
    const order = await newOrder(svc);
    const limit = Math.max(5, Math.floor(cfg.rateLimitPerMinute / 2));
    const codes: string[] = [];
    for (let i = 0; i < limit + 3; i++) codes.push(await codeOf(svc.relayPay(await signFor(order, clock.t), { ip: `9.9.${i >> 8}.${i & 255}` })));
    expect(codes.slice(0, limit).every((c) => c === "relayer_paused")).toBe(true);
    expect(codes[limit]).toBe("rate_limited");
    expect(MERCHANT_ID).toBeDefined();
  });
});
