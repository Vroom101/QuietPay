import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRefundStatus } from "../src/payment.js";
import { rememberToken } from "../src/order-token.js";

const ID = "0x" + "ab".repeat(32);
const OK = {
  orderId: ID, status: "partially_refunded", amountPaid: "17000000", totalRefunded: "5000000", remaining: "12000000",
  currency: "USDT", lastUpdatedAt: 1_800_000_000,
  refunds: [{ amount: "5000000", status: "settled", txHash: "0x" + "cd".repeat(32), createdAt: 1_800_000_000 }],
};

let store: Record<string, string>;
beforeEach(() => {
  store = {};
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });
});
afterEach(() => vi.unstubAllGlobals());

describe("Feature: the customer receipt shows refund status from the store's customer endpoint", () => {
  it("Scenario: the order token is sent as a header, never in the URL", async () => {
    rememberToken(ID, "tok-abcdefghijklmnopqrstuvwxyz0123456789");
    const f = vi.fn(async () => new Response(JSON.stringify(OK), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const out = await readRefundStatus(ID, new AbortController().signal);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/orders/${ID}/refund-status`);
    expect(url).not.toContain("tok-");
    expect((init.headers as Record<string, string>)["Quietpay-Order-Token"]).toBe("tok-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out?.totalRefunded).toBe("5000000");
    expect(out?.refunds).toHaveLength(1);
  });

  it("Scenario: an unknown order or wrong token (uniform 404) shows nothing", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    expect(await readRefundStatus(ID, new AbortController().signal)).toBeUndefined();
  });

  it("Scenario: a malformed or leaking response is ignored, not rendered", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ...OK, merchantId: "0x1", refundSigner: "0x2" }), { status: 200 }));
    expect(await readRefundStatus(ID, new AbortController().signal)).toBeUndefined(); // the strict schema rejects extra fields
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
    expect(await readRefundStatus(ID, new AbortController().signal)).toBeUndefined();
  });

  it("Scenario: a network failure shows nothing and does not throw", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    expect(await readRefundStatus(ID, new AbortController().signal)).toBeUndefined();
  });
});
