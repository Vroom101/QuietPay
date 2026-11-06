import { afterEach, describe, expect, it, vi } from "vitest";
import { orderSettled } from "@quietpay/shared/fixtures";
import { DashboardError, fixtureOrders, listOrders } from "../src/lib/api";
import { toRow } from "../src/lib/view";

afterEach(() => vi.unstubAllGlobals());

describe("listOrders", () => {
  it("returns fixtures without any network when toggled on", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const orders = await listOrders({
      relayerUrl: "http://x",
      apiKey: "",
      useFixtures: true,
    });
    expect(orders).toEqual(fixtureOrders());
    expect(orders.map((o) => o.status)).toEqual(
      expect.arrayContaining([
        "created",
        "pending",
        "settled",
        "failed",
        "expired",
      ]),
    );
    expect(f).not.toHaveBeenCalled();
  });

  it("sends the bearer key and parses ListOrdersResponse", async () => {
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ orders: [orderSettled] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", f);
    const orders = await listOrders({
      relayerUrl: "http://relayer/",
      apiKey: "secret",
    });
    expect(orders).toHaveLength(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://relayer/v1/orders");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret",
    );
  });

  it("reports a rejected key and a malformed body in plain words", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    await expect(
      listOrders({ relayerUrl: "http://r", apiKey: "bad" }),
    ).rejects.toThrow("dashboard access token was not accepted");
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }),
    );
    await expect(
      listOrders({ relayerUrl: "http://r", apiKey: "k" }),
    ).rejects.toBeInstanceOf(DashboardError);
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
});

it("loads dashboard orders through the merchant server with its separate access token", async () => {
  const f = vi.fn(
    async () => new Response(JSON.stringify({ orders: [orderSettled] })),
  );
  vi.stubGlobal("fetch", f);
  await listOrders({
    merchantUrl: "/api/merchant/",
    apiKey: "dashboard-access",
  });
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/merchant/orders");
  expect((init.headers as Record<string, string>).authorization).toBe(
    "Bearer dashboard-access",
  );
  expect(init.redirect).toBe("error");
});
