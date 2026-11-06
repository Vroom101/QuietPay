import { describe, expect, it } from "vitest";
import { makeEnv, newOrder, signFor, MERCHANT_ID } from "./helpers.js";
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("gas spent per order (merchant list only)", () => {
  it("adds the pay tx gas to the merchant's order list and never to the public order", async () => {
    const e = makeEnv();
    const order = await newOrder(e.svc);
    const res = await e.svc.relayPay(await signFor(order, e.clock.t), { ip: "203.0.113.1" });
    await flush();
    const spent = (e.db.raw.prepare("SELECT wei FROM spend WHERE tx_hash=?").get(res.txHash) as { wei: string } | undefined)?.wei;
    expect(spent).toBeTruthy();
    const listed = e.svc.listOrders(MERCHANT_ID).find((o) => o.id === order.id)!;
    expect(listed.gasWei).toBe(spent);
    expect((e.svc.getOrder(order.id) as { gasWei?: string }).gasWei).toBeUndefined();
    e.db.close();
  });

  it("counts refund txs (and their replacements) once each, and reports 0 for an unpaid order", async () => {
    const e = makeEnv();
    const paid = await newOrder(e.svc);
    const res = await e.svc.relayPay(await signFor(paid, e.clock.t), { ip: "203.0.113.1" });
    await flush();
    const open = await newOrder(e.svc);
    const refundId = "0x" + "ab".repeat(32), h1 = "0x" + "c1".repeat(32), h2 = "0x" + "c2".repeat(32);
    e.db.raw.prepare("INSERT INTO refunds VALUES (?,?,?,?,?,'settled',?,?,?,?,?,?)").run(refundId, paid.id, MERCHANT_ID, "1", 0, "0x", 0, 100, h2, null, 0);
    e.db.raw.prepare("INSERT INTO relay_attempts VALUES (?,?,?,?,?,?,?,?)").run(h1, refundId, "0x", 7, "21000", "1", 0, 0);
    e.db.raw.prepare("INSERT INTO relay_attempts VALUES (?,?,?,?,?,?,?,?)").run(h2, refundId, "0x", 7, "21000", "2", 0, 1);
    e.db.recordSpend(h1, 0, 1000n);
    e.db.recordSpend(h2, 0, 2000n);
    const payWei = BigInt((e.db.raw.prepare("SELECT wei FROM spend WHERE tx_hash=?").get(res.txHash) as { wei: string }).wei);
    const list = e.svc.listOrders(MERCHANT_ID);
    expect(list.find((o) => o.id === paid.id)!.gasWei).toBe((payWei + 3000n).toString());
    expect(list.find((o) => o.id === open.id)!.gasWei).toBe("0");
    e.db.close();
  });

  it("handles an empty merchant", () => {
    const e = makeEnv();
    expect(e.db.gasWeiByOrder([]).size).toBe(0);
    expect(e.svc.listOrders("0x" + "00".repeat(32))).toEqual([]);
    e.db.close();
  });
});
