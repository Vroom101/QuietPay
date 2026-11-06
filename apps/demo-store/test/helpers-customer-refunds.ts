import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import Database from "better-sqlite3";
import * as realSdk from "@quietpay/merchant-sdk";
import { ORDER_TOKEN_HEADER, merchantIdFromSlug, type Order, type Refund } from "@quietpay/shared";
import { FIXTURE_PAYOUT, FIXTURE_REFUND_SIGNER, makeOrder } from "@quietpay/shared/fixtures";
import { signWebhook } from "@quietpay/shared/webhook";
import { buildApp, type MerchantSdk, type StoreConfig } from "../server/app.js";

export const SECRET = "whsec_TEST_SECRET_VALUE_123";
export const API_KEY = "qp_live_TEST_API_KEY_VALUE_456";
export const MERCHANT = merchantIdFromSlug("demo-store");
export const PAID = "50000000"; // two tees at 25.00 USDT
export const hex32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;

export function world(over: Partial<StoreConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "b-build-w5-"));
  const dbPath = join(dir, "customer.db");
  const relayer = new Map<string, Order>();
  const refunds = new Map<string, Refund[]>();
  let seq = 0;
  let clock = Date.now();
  const sdk = {
    createOrder: vi.fn(async (o: { amount: string }) => {
      const order = makeOrder({ id: hex32(0xa000 + ++seq), amount: o.amount, fee: "0" });
      relayer.set(order.id, order);
      return order;
    }),
    getOrder: vi.fn(async (o: { orderId: string }) => {
      const order = relayer.get(o.orderId.toLowerCase());
      if (!order) throw new Error("order_not_found");
      return order;
    }),
    listRefunds: vi.fn(async (o: { orderId: string }) => refunds.get(o.orderId.toLowerCase()) ?? []),
    verifyWebhook: vi.fn(realSdk.verifyWebhook),
  };
  const app = buildApp(sdk as unknown as MerchantSdk, {
    baseUrl: "http://relayer.invalid", apiKey: API_KEY, merchantId: MERCHANT, webhookSecret: SECRET,
    payout: FIXTURE_PAYOUT, customerRefundDatabasePath: dbPath, now: () => clock, ...over,
  });
  let evt = 0;
  const w = {
    app, sdk, relayer, refunds, dbPath,
    advance: (ms: number) => { clock += ms; },
    count: (table: string) => {
      const db = new Database(dbPath, { readonly: true });
      try { return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c; } finally { db.close(); }
    },
    async close() { await app.close(); rmSync(dir, { recursive: true, force: true }); },
    async checkout(remoteAddress = "10.0.0.1") {
      const res = await app.inject({ method: "POST", url: "/api/checkout", remoteAddress, payload: { items: [{ id: "tee", quantity: 2 }] } });
      return { res, orderId: res.json().orderId as `0x${string}`, token: res.headers[ORDER_TOKEN_HEADER.toLowerCase()] as string };
    },
    status: (orderId: string, token?: string, remoteAddress = "10.0.0.2", query = "") =>
      app.inject({ method: "GET", url: `/api/orders/${orderId}/refund-status${query}`, remoteAddress, headers: token === undefined ? {} : { [ORDER_TOKEN_HEADER]: token } }),
    setRelayer(orderId: string, status: Order["status"], refundedAmount?: string) {
      relayer.set(orderId.toLowerCase(), { ...relayer.get(orderId.toLowerCase())!, status, ...(refundedAmount ? { refundedAmount } : {}) });
    },
    event(type: string, orderId: string, data: Record<string, unknown> = {}, id?: string, createdAt = Math.floor(Date.now() / 1000)) {
      return {
        id: id ?? `evt_w5_${String(++evt).padStart(6, "0")}`, type, createdAt,
        data: { orderId, merchantId: MERCHANT, amount: PAID, fee: "0", payout: FIXTURE_PAYOUT, ...data },
      };
    },
    refundEvent(orderId: string, index: number, amount: string, total: string, id?: string, extra: Record<string, unknown> = {}) {
      return w.event("payment.refunded", orderId, {
        refundId: hex32(0xbeef00 + index), refundAmount: amount, totalRefunded: total, refundIndex: index,
        txHash: hex32(0xcafe00 + index), ...extra,
      }, id);
    },
    postRaw: (body: string, signature?: string) =>
      app.inject({ method: "POST", url: "/webhooks/quietpay", headers: { "content-type": "application/json", ...(signature ? { "quietpay-signature": signature } : {}) }, payload: body }),
    post(event: unknown, timestamp?: number) {
      const body = JSON.stringify(event);
      return w.postRaw(body, signWebhook(SECRET, body, timestamp));
    },
    async settle(orderId: string) {
      w.setRelayer(orderId, "settled");
      return w.post(w.event("payment.settled", orderId, { payer: "0x3333333333333333333333333333333333333333" }));
    },
  };
  return w;
}
export const LEAK_STRINGS = [API_KEY, SECRET, FIXTURE_REFUND_SIGNER, FIXTURE_PAYOUT, MERCHANT];
