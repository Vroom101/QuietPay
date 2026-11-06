import { afterEach, describe, expect, it, vi } from "vitest";
import { orderPartiallyRefunded, orderPending, orderSettled } from "@quietpay/shared/fixtures";
import { DashboardError, fixtureOrders, listOrders } from "../src/lib/api";
import { toRow } from "../src/lib/view";

afterEach(() => vi.unstubAllGlobals());

describe("listOrders", () => {
  it("returns fixtures without any network when toggled on", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const orders = await listOrders({ relayerUrl: "http://x", apiKey: "", useFixtures: true });
    expect(orders).toEqual(fixtureOrders());
    expect(orders.map((o) => o.status)).toEqual(expect.arrayContaining(["created", "pending", "settled", "failed", "expired"]));
    expect(f).not.toHaveBeenCalled();
  });

  it("sends the bearer key and parses ListOrdersResponse", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ orders: [orderPartiallyRefunded] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const orders = await listOrders({ relayerUrl: "http://relayer/", apiKey: "secret" });
    expect(orders).toHaveLength(1);
    expect(orders[0]?.refundedAmount).toBe("10000000");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://relayer/v1/orders");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });

  it("reports a rejected key and a malformed body in plain words", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    await expect(listOrders({ relayerUrl: "http://r", apiKey: "bad" })).rejects.toThrow("API key was not accepted");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    await expect(listOrders({ relayerUrl: "http://r", apiKey: "k" })).rejects.toBeInstanceOf(DashboardError);
  });
});

describe("toRow", () => {
  it("formats amount and fee, keeps payer and receipt link", () => {
    const r = toRow(orderSettled);
    expect(r.amount).toBe("25.00 USDT");
    expect(r.fee).toBe("0.05 USDT");
    expect(r.payer).toBe(orderSettled.payer);
    expect(r.explorerUrl).toBe(orderSettled.explorerUrl);
  });

  it.each([
    ["0", "No refund", "0.00 USDT", "25.00 USDT"],
    ["10000000", "Partially refunded", "10.00 USDT", "15.00 USDT"],
    ["1", "Partially refunded", "0.000001 USDT", "24.999999 USDT"],
    ["25000000", "Fully refunded", "25.00 USDT", "0.00 USDT"],
  ])("derives the refund summary for %s base units", (refundedAmount, label, refunded, remaining) => {
    expect(toRow({ ...orderSettled, refundedAmount }).refund).toEqual({ label, refunded, remaining });
  });

  it("keeps missing, unsettled, or inconsistent refund data unavailable", () => {
    expect(toRow(orderSettled).refund).toBeNull();
    expect(toRow({ ...orderPending, refundedAmount: "0" }).refund).toBeNull();
    expect(toRow({ ...orderSettled, refundedAmount: "25000001" }).refund).toBeNull();
  });
});
