import { describe, expect, it } from "vitest";
import { makeEnv, newOrder, signFor, MERCHANT_ID, payer } from "./helpers.js";
import { Db } from "../src/db.js";
import { RelayerService } from "../src/service.js";
const flush = () => new Promise(r => setTimeout(r, 0));

// Main's hardening-r3 / pentest-round3..7 suites own payment recovery semantics.
// These cover the branch's extension points against that state machine.
describe("main recovery with merchant extensions", () => {
  it("persists main's signed payment and recovers it after reopening the database", async () => {
    const e = makeEnv(); e.chain.holdReceipt = true;
    const order = await newOrder(e.svc);
    const response = await e.svc.relayPay(await signFor(order, e.clock.t), { ip: "203.0.113.1" });
    const row = e.db.getOrder(order.id)!;
    expect(row.raw_tx).toBeTruthy();
    expect(row.tx_nonce).toBe(0);
    const db = new Db(e.db.raw.serialize());
    e.chain.holdReceipt = false;
    const restarted = new RelayerService({ cfg: e.cfg, db, chain: e.chain, now: () => e.clock.t });
    restarted.recoverPending(); await flush();
    expect(restarted.getOrder(order.id)).toMatchObject({ status: "settled", txHash: response.txHash });
    db.close(); e.db.close();
  });
  it("keeps extension gas reservations beyond the hourly window", () => {
    const e = makeEnv();
    const id = "0x" + "ab".repeat(32), hash = "0x" + "cd".repeat(32);
    e.db.raw.prepare("INSERT INTO refunds VALUES (?,?,?,?,?,'pending',?,?,?,?,?,?)")
      .run(id, id, MERCHANT_ID, "1", 0, "0x", 0, 100, hash, null, 0);
    e.db.recordSpend(hash, 0, 123n);
    expect(e.db.reservedSpend(e.clock.t - 3600)).toBe(123n);
    e.db.close();
  });
  it("keeps a refunded payment in payer volume and refuses payment replay", async () => {
    const e = makeEnv(); const order = await newOrder(e.svc);
    await e.svc.relayPay(await signFor(order, e.clock.t), { ip: "203.0.113.1" }); await flush();
    e.db.transition(order.id, ["settled"], "refunded");
    expect(e.db.payerVolume(payer.address, 0)).toBe(BigInt(order.amount));
    await expect(e.svc.relayPay(await signFor(order, e.clock.t, { validBefore: e.clock.t + 200 }), { ip: "203.0.113.2" })).rejects.toMatchObject({ code: "already_settled" });
    e.db.close();
  });
});
