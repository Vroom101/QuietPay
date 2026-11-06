import { afterEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { CustomerRefundStatus, ORDER_TOKEN_HEADER } from "@quietpay/shared";
import { signWebhook } from "@quietpay/shared/webhook";
import { ipKey, tokenMatches, hashToken, newOrderToken } from "../server/customer-refunds.js";
import { API_KEY, LEAK_STRINGS, PAID, SECRET, hex32, world } from "./helpers-customer-refunds.js";

let w: ReturnType<typeof world>;
afterEach(async () => { vi.restoreAllMocks(); await w?.close(); });

const ALLOWED_KEYS = ["orderId", "status", "amountPaid", "totalRefunded", "remaining", "currency", "lastUpdatedAt", "refunds"].sort();

describe("token and ip primitives", () => {
  it("tokens are 32 random bytes in base64url and only the digest is compared", () => {
    const t = newOrderToken();
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newOrderToken()).not.toBe(t);
    const hex = hashToken(t).toString("hex");
    expect(tokenMatches(t, hex)).toBe(true);
    expect(tokenMatches(newOrderToken(), hex)).toBe(false);
    expect(tokenMatches(undefined, hex)).toBe(false);
    expect(tokenMatches(t, undefined)).toBe(false);
  });
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    ["::ffff:203.0.113.9", "203.0.113.9"],
    ["2001:db8:1:2::1", "v6:2001:0db8:0001:0002"],
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "v6:2001:0db8:0001:0002"],
    ["2001:DB8:1:3::1", "v6:2001:0db8:0001:0003"],
    ["::1", "v6:0000:0000:0000:0000"],
  ])("ipKey(%s)", (ip, key) => expect(ipKey(ip)).toBe(key));
});

describe("ATTACK: IDOR and token guessing", () => {
  it("order A fetched with order B's token is byte-identical to an unknown order id", async () => {
    w = world();
    const a = await w.checkout(); const b = await w.checkout();
    await w.settle(a.orderId); await w.settle(b.orderId);
    const idor = await w.status(a.orderId, b.token);
    const unknown = await w.status(hex32(0xdead), b.token);
    const missing = await w.status(a.orderId);
    const malformed = await w.status("not-an-order", b.token);
    for (const r of [idor, unknown, missing, malformed]) {
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe('{"error":"not_found"}');
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["vary"]).toBe(ORDER_TOKEN_HEADER);
    }
    expect(idor.headers["content-length"]).toBe(unknown.headers["content-length"]);
    expect((await w.status(a.orderId, a.token)).statusCode).toBe(200);
  });

  it("wrong tokens, a 31-byte token and a duplicated header never authenticate", async () => {
    w = world();
    const a = await w.checkout();
    for (const t of [randomBytes(31).toString("base64url"), randomBytes(32).toString("base64url"), "", " " + a.token, a.token + "=", a.token.toUpperCase()]) {
      expect((await w.status(a.orderId, t)).statusCode).toBe(404);
    }
    const dup = await w.app.inject({ method: "GET", url: `/api/orders/${a.orderId}/refund-status`, headers: { [ORDER_TOKEN_HEADER]: [a.token, a.token] as unknown as string } });
    expect(dup.statusCode).toBe(404);
  });

  it("a token in the query string is refused with 400 even when it is correct", async () => {
    w = world();
    const a = await w.checkout();
    for (const q of [`?token=${a.token}`, `?Token=${a.token}`, "?api_token=x", `?x=1&order-token=${a.token}`, `?%74oken=${a.token}`]) {
      const r = await w.status(a.orderId, a.token, "10.0.0.3", q);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain(a.token);
    }
  });

  it("rate limits across two addresses of one IPv6 /64, but not another /64; failures cost double", async () => {
    w = world({ customerRefundRateLimit: { perIp: 10, perOrder: 1000, windowMs: 60_000 } });
    const a = await w.checkout();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await w.status(a.orderId, "wrong", i % 2 ? "2001:db8:aa:bb::1" : "2001:db8:aa:bb:1:2:3:4")).statusCode);
    expect(codes.slice(0, 5)).toEqual([404, 404, 404, 404, 404]); // 5 failures x 2 = 10
    expect(codes[5]).toBe(429);
    // even the right token is refused from that /64 until the window passes
    expect((await w.status(a.orderId, a.token, "2001:db8:aa:bb:ffff::9")).statusCode).toBe(429);
    expect((await w.status(a.orderId, a.token, "2001:db8:aa:cc::1")).statusCode).toBe(200);
    w.advance(61_000);
    expect((await w.status(a.orderId, a.token, "2001:db8:aa:bb::1")).statusCode).toBe(200);
  });

  it("per-order budget throttles guessing from many networks but never locks out the real holder", async () => {
    w = world({ customerRefundRateLimit: { perIp: 1000, perOrder: 10, windowMs: 60_000 } });
    const a = await w.checkout();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await w.status(a.orderId, "guess", `198.51.100.${i + 1}`)).statusCode);
    expect(codes.slice(0, 4)).toEqual([404, 404, 404, 404]);
    expect(codes.at(-1)).toBe(429);
    expect((await w.status(a.orderId, a.token, "192.0.2.77")).statusCode).toBe(200);
  });

  it("unknown vs wrong-token timing is comparable (no oracle)", async () => {
    w = world({ customerRefundRateLimit: { perIp: 1e9, perOrder: 1e9 } });
    const a = await w.checkout();
    const median = async (id: string) => {
      const xs: number[] = [];
      for (let i = 0; i < 150; i++) { const t = process.hrtime.bigint(); await w.status(id, newOrderToken()); xs.push(Number(process.hrtime.bigint() - t)); }
      return xs.sort((p, q) => p - q)[75]!;
    };
    await median(a.orderId); // warm up
    const wrong = await median(a.orderId); const unknown = await median(hex32(0x1234));
    expect(unknown / wrong).toBeGreaterThan(0.4);
    expect(unknown / wrong).toBeLessThan(2.5);
  });
});

describe("ATTACK: response leakage and mass assignment", () => {
  it("returns exactly the allowlisted keys and none of the secrets", async () => {
    w = world();
    const a = await w.checkout();
    await w.settle(a.orderId);
    await w.post(w.refundEvent(a.orderId, 0, "10000000", "10000000"));
    const r = await w.status(a.orderId, a.token);
    const body = r.json();
    expect(Object.keys(body).sort()).toEqual(ALLOWED_KEYS);
    expect(Object.keys(body.refunds[0]).sort()).toEqual(["amount", "createdAt", "status", "txHash"]);
    for (const s of [...LEAK_STRINGS, a.token, hashToken(a.token).toString("hex"), hex32(0xbeef00), "failureCode", "refundSigner", "token_hash", "evt_w5"])
      expect(r.body.toLowerCase()).not.toContain(s.toLowerCase());
    expect(CustomerRefundStatus.safeParse({ ...body, merchantId: "x" }).success).toBe(false);
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("the checkout response carries the token once, uncacheable, and the body shape is unchanged", async () => {
    w = world();
    const { res, token } = await w.checkout();
    expect(Object.keys(res.json()).sort()).toEqual(["amount", "orderId", "payout"]);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.body).not.toContain(token);
    expect(w.count("order_access")).toBe(1);
  });

  it("stores only a hash of the token", async () => {
    w = world();
    const { token } = await w.checkout();
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(w.dbPath, { readonly: true });
    const rows = JSON.stringify(db.prepare("SELECT * FROM order_access").all());
    db.close();
    expect(rows).not.toContain(token);
    expect(rows).toContain(hashToken(token).toString("hex"));
  });

  it("extra fields in checkout bodies and webhook data change nothing", async () => {
    w = world();
    const res = await w.app.inject({ method: "POST", url: "/api/checkout", payload: { items: [{ id: "tee", quantity: 2 }], status: "refunded", amountPaid: "1", token_hash: "00", totalRefunded: PAID } });
    const orderId = res.json().orderId;
    const token = res.headers[ORDER_TOKEN_HEADER.toLowerCase()] as string;
    expect((await w.status(orderId, "00")).statusCode).toBe(404);
    await w.settle(orderId);
    await w.post(w.refundEvent(orderId, 0, "1000000", "1000000", undefined, { status: "refunded", amountPaid: "1", token_hash: "00", remaining: "0" }));
    const body = (await w.status(orderId, token)).json();
    expect(body).toMatchObject({ status: "partially_refunded", amountPaid: PAID, totalRefunded: "1000000", remaining: "49000000" });
  });

  it("the logger redacts the token header", async () => {
    let out = "";
    const stream = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
    w = world({ logger: { stream } });
    const a = await w.checkout();
    w.app.log.info({ req: { headers: { "quietpay-order-token": a.token, authorization: "Bearer " + API_KEY } } }, "probe");
    await w.status(a.orderId, a.token);
    expect(out).toContain("probe");
    expect(out).not.toContain(a.token);
    expect(out).not.toContain(API_KEY);
  });
});

describe("ATTACK: webhook replay, reorder, tamper", () => {
  it("a refund that arrives before settlement is parked and applied once when the order settles", async () => {
    w = world();
    const a = await w.checkout();
    w.setRelayer(a.orderId, "settled");
    const ev = w.refundEvent(a.orderId, 0, "20000000", "20000000");
    expect((await w.post(ev)).statusCode).toBe(200);
    expect(w.count("pending_events")).toBe(1);
    expect(w.count("customer_refunds")).toBe(0);
    expect((await w.status(a.orderId, a.token)).json()).toMatchObject({ status: "pending", totalRefunded: "0" });
    await w.settle(a.orderId);
    expect(w.count("pending_events")).toBe(0);
    expect(w.count("customer_refunds")).toBe(1);
    expect((await w.status(a.orderId, a.token)).json()).toMatchObject({ status: "partially_refunded", totalRefunded: "20000000", remaining: "30000000" });
    expect((await w.post(ev)).json()).toEqual({ received: true, duplicate: true });
    expect(w.count("customer_refunds")).toBe(1);
  });

  it("a replayed event id changes nothing, including after other events moved the totals on", async () => {
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    const first = w.refundEvent(a.orderId, 0, "10000000", "10000000");
    await w.post(first);
    await w.post(w.refundEvent(a.orderId, 1, "40000000", "50000000"));
    const before = (await w.status(a.orderId, a.token)).body;
    expect((await w.post(first)).json().duplicate).toBe(true);
    expect((await w.status(a.orderId, a.token)).body).toBe(before);
    expect(JSON.parse(before).status).toBe("refunded");
  });

  it("an older (lower-total) event arriving late never lowers totals or status", async () => {
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    await w.post(w.refundEvent(a.orderId, 1, "40000000", "50000000"));
    await w.post(w.refundEvent(a.orderId, 0, "10000000", "10000000"));
    const body = (await w.status(a.orderId, a.token)).json();
    expect(body).toMatchObject({ status: "refunded", totalRefunded: "50000000", remaining: "0" });
    expect(body.refunds).toHaveLength(2);
    // a late settled-event for the same order does not reset it either
    await w.post(w.event("payment.settled", a.orderId, {}));
    expect((await w.status(a.orderId, a.token)).json().status).toBe("refunded");
  });

  it("an over-paid event is rejected, logged, and stores nothing", async () => {
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    expect((await w.post(w.refundEvent(a.orderId, 0, "10000000", "50000001"))).statusCode).toBe(400);
    expect((await w.post(w.refundEvent(a.orderId, 0, "50000001", "50000001"))).statusCode).toBe(400);
    // a mismatching order amount is not confirmed by the relayer: acknowledged, but nothing is stored
    expect((await w.post(w.refundEvent(a.orderId, 0, "1000000", "1000000", undefined, { amount: "99" }))).statusCode).toBe(200);
    expect(w.count("customer_refunds")).toBe(0);
    expect((await w.status(a.orderId, a.token)).json().totalRefunded).toBe("0");
  });

  it("an over-paid refund arriving before settlement is rejected and not parked", async () => {
    w = world();
    const a = await w.checkout();
    w.setRelayer(a.orderId, "settled");
    expect((await w.post(w.refundEvent(a.orderId, 0, "1000000", "50000001"))).statusCode).toBe(400);
    expect(w.count("pending_events")).toBe(0);
  });

  it("an event for an unknown order is 400 and nothing is stored", async () => {
    w = world();
    const ghost = hex32(0x999999);
    w.relayer.set(ghost, { ...(await w.sdk.createOrder({ amount: PAID })), id: ghost, status: "settled" });
    const calls = w.sdk.getOrder.mock.calls.length;
    expect((await w.post(w.refundEvent(ghost, 0, "1000000", "1000000"))).statusCode).toBe(400);
    expect(w.count("pending_events") + w.count("customer_refunds")).toBe(0);
    expect(w.sdk.getOrder.mock.calls.length).toBe(calls);
  });

  it("a refund the relayer does not confirm is ignored", async () => {
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    w.setRelayer(a.orderId, "settled", "5000000"); // relayer says only 5 USDT refunded
    await w.post(w.refundEvent(a.orderId, 0, "10000000", "10000000"));
    expect(w.count("customer_refunds")).toBe(0);
    expect(w.sdk.getOrder).toHaveBeenCalled();
  });

  it("a tampered body or a 301-second-old timestamp is 400 and JSON.parse and the handler never ran", async () => {
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    const good = JSON.stringify(w.refundEvent(a.orderId, 0, "1000000", "1000000"));
    const tampered = good.replace("1000000", "9000000");
    const calls0 = w.sdk.getOrder.mock.calls.length;
    const parse = vi.spyOn(JSON, "parse");
    const r1 = await w.postRaw(tampered, signWebhook(SECRET, good));
    const old = Math.floor(Date.now() / 1000) - 301;
    const r2 = await w.postRaw(good, signWebhook(SECRET, good, old));
    const r3 = await w.postRaw(good, signWebhook("another-secret", good));
    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([400, 400, 400]);
    expect(parse.mock.calls.filter(([s]) => s === tampered || s === good)).toHaveLength(0);
    expect(w.sdk.getOrder.mock.calls.length).toBe(calls0);
    expect(w.count("customer_refunds")).toBe(0);
    parse.mockRestore();
    expect((await w.postRaw(good, signWebhook(SECRET, good))).statusCode).toBe(200);
  });

  it("an event for another merchant is refused", async () => {
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    const ev = w.refundEvent(a.orderId, 0, "1000000", "1000000");
    ev.data.merchantId = hex32(7);
    expect((await w.post(ev)).statusCode).toBe(400);
    expect(w.count("customer_refunds")).toBe(0);
  });

  it("huge and deeply nested webhook bodies are refused without crashing", async () => {
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    const huge = JSON.stringify({ pad: "x".repeat(2_000_000) });
    expect((await w.postRaw(huge, signWebhook(SECRET, huge))).statusCode).toBe(413);
    const mid = JSON.stringify({ pad: "x".repeat(100_000) });
    expect((await w.postRaw(mid, signWebhook(SECRET, mid))).statusCode).toBe(413);
    const nested = "[".repeat(30_000) + "]".repeat(30_000);
    expect((await w.postRaw(nested, signWebhook(SECRET, nested))).statusCode).toBe(400);
    const nestedObj = '{"a":'.repeat(5000) + "1" + "}".repeat(5000);
    expect((await w.postRaw(nestedObj, signWebhook(SECRET, nestedObj))).statusCode).toBe(400);
    expect((await w.status(a.orderId, a.token)).statusCode).toBe(200);
  });

  it("concurrent duplicate deliveries apply exactly once", async () => {
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    const ev = w.refundEvent(a.orderId, 0, "10000000", "10000000");
    const rs = await Promise.all(Array.from({ length: 12 }, () => w.post(ev)));
    expect(rs.filter((r) => r.statusCode === 200 && !r.json().duplicate)).toHaveLength(1);
    expect(w.count("customer_refunds")).toBe(1);
    expect((await w.status(a.orderId, a.token)).json().totalRefunded).toBe("10000000");
    // two distinct events carrying the same refundIndex still produce one row
    const two = await Promise.all([w.post(w.refundEvent(a.orderId, 1, "5000000", "15000000")), w.post(w.refundEvent(a.orderId, 1, "5000000", "15000000"))]);
    expect(two.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(w.count("customer_refunds")).toBe(2);
  });
});

describe("reconciliation with the relayer", () => {
  const refundRow = (orderId: string, i: number, amount: string, status: "pending" | "settled" | "failed") =>
    ({ id: hex32(0x77 + i), orderId, amount, refundIndex: i, status, txHash: status === "settled" ? hex32(0x88 + i) : undefined, createdAt: 1_800_000_100 + i }) as never;

  it("only syncs settled orders older than 60 s and merges monotonically", async () => {
    w = world();
    const a = await w.checkout();
    w.refunds.set(a.orderId, [refundRow(a.orderId, 0, "10000000", "pending")]);
    await w.status(a.orderId, a.token); w.advance(120_000);
    await w.status(a.orderId, a.token);
    expect(w.sdk.listRefunds).not.toHaveBeenCalled(); // not settled yet
    await w.settle(a.orderId);
    w.advance(30_000);
    await w.status(a.orderId, a.token);
    expect(w.sdk.listRefunds).not.toHaveBeenCalled(); // synced less than 60 s ago
    w.advance(40_000);
    const r = (await w.status(a.orderId, a.token)).json();
    expect(w.sdk.listRefunds).toHaveBeenCalledTimes(1);
    expect(w.sdk.listRefunds.mock.calls[0]![0]).toMatchObject({ apiKey: API_KEY, orderId: a.orderId });
    expect(r.refunds).toEqual([{ amount: "10000000", status: "pending", createdAt: 1_800_000_100 }]);
    expect(r.totalRefunded).toBe("0");
    // relayer completes it; then later lists a stale view that must not lower anything
    w.refunds.set(a.orderId, [refundRow(a.orderId, 0, "10000000", "settled")]);
    w.advance(61_000);
    expect((await w.status(a.orderId, a.token)).json()).toMatchObject({ status: "partially_refunded", totalRefunded: "10000000" });
    w.refunds.set(a.orderId, [refundRow(a.orderId, 0, "10000000", "pending")]);
    w.advance(61_000);
    const after = (await w.status(a.orderId, a.token)).json();
    expect(after).toMatchObject({ status: "partially_refunded", totalRefunded: "10000000" });
    expect(after.refunds[0].status).toBe("settled");
    expect(after.refunds[0].txHash).toBe(hex32(0x88));
  });

  it("rejects an inconsistent list (over-paid, other order) and keeps the stored state; relayer errors are not fatal", async () => {
    w = world();
    const a = await w.checkout(); const b = await w.checkout(); await w.settle(a.orderId);
    w.refunds.set(a.orderId, [refundRow(a.orderId, 0, "30000000", "settled"), refundRow(a.orderId, 1, "30000000", "settled")]);
    w.advance(61_000);
    expect((await w.status(a.orderId, a.token)).json()).toMatchObject({ totalRefunded: "0", refunds: [] });
    w.refunds.set(a.orderId, [refundRow(b.orderId, 0, "1000000", "settled")]);
    w.advance(61_000);
    expect((await w.status(a.orderId, a.token)).json().refunds).toEqual([]);
    w.sdk.listRefunds.mockRejectedValueOnce(new Error("relayer down"));
    w.advance(61_000);
    expect((await w.status(a.orderId, a.token)).statusCode).toBe(200);
  });
});

describe("ATTACK: legacy /paid is no longer open for tokened orders", () => {
  it("needs the token for new orders and answers wrong or missing tokens exactly like an unknown order", async () => {
    w = world();
    const a = await w.checkout(); const b = await w.checkout(); await w.settle(a.orderId);
    const paid = (token?: string, id: string = a.orderId) => w.app.inject({ method: "GET", url: `/api/orders/${id}/paid`, headers: token ? { [ORDER_TOKEN_HEADER]: token } : {} });
    const unknown = await paid(undefined, hex32(0xfeed));
    for (const r of [await paid(), await paid(b.token), await paid("junk")]) {
      expect(r.statusCode).toBe(unknown.statusCode);
      expect(r.body).toBe(unknown.body);
      expect(r.body).not.toContain("payer");
    }
    const ok = (await paid(a.token)).json();
    expect(ok).toMatchObject({ paid: true, orderId: a.orderId });
    expect((await paid(a.token)).headers["cache-control"]).toBe("no-store");
  });
});
