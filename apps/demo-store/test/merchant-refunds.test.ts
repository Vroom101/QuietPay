import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { token, type Refund, type RefundContext } from "@quietpay/shared";
import { orderSettled } from "@quietpay/shared/fixtures";
import * as actualSdk from "@quietpay/merchant-sdk";
import { buildApp } from "../server/app.js";
const key = ("0x" + "11".repeat(32)) as `0x${string}`;
const access = "dashboard-test-access-token-at-least-32-characters";
const requestId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const refundId = "0x" + "aa".repeat(32);
const c: RefundContext = {
  orderId: orderSettled.id,
  merchantId: orderSettled.merchantId,
  payer: orderSettled.payer!,
  refundSigner: privateKeyToAccount(key).address,
  amountPaid: "25000000",
  refunded: "0",
  refundIndex: 0,
  refundBalance: "25000000",
  chainId: token.chainId,
  token: token.address,
  router: orderSettled.checkout.router,
  domain: token.eip712Domain,
};
const open: ReturnType<typeof buildApp>[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
  for (const path of dirs.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function setup(path = ":memory:", context = { ...c }) {
  const history: Refund[] = [];
  const sdk = {
    ...actualSdk,
    getRefundContext: vi.fn(async () => context),
    listRefunds: vi.fn(async () => [...history]),
    listOrders: vi.fn(async () => [orderSettled]),
    refund: vi.fn(async (opts: actualSdk.RefundOptions) => {
      const refund: Refund = {
        id: refundId,
        orderId: opts.orderId,
        amount: opts.amount!,
        refundIndex: opts.refundIndex,
        status: "pending",
        createdAt: 123,
      };
      history.push(refund);
      return refund;
    }),
  };
  const config = {
    baseUrl: "http://relayer",
    apiKey: "server-only-relayer-key",
    merchantId: c.merchantId as `0x${string}`,
    webhookSecret: "secret",
    refunds: {
      dashboardToken: access,
      router: c.router as `0x${string}`,
      refundSignerPrivateKey: key,
      databasePath: path,
    },
  };
  const app = buildApp(sdk, config);
  open.push(app);
  const request = (
    method: "GET" | "POST",
    suffix = "refund-context",
    body?: Record<string, unknown>,
    bearer = access,
  ) =>
    app.inject({
      method,
      url: `/api/merchant/orders/${c.orderId}/${suffix}`,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      payload: body,
    });
  const submit = (patch = {}) =>
    request("POST", "refunds", {
      requestId,
      amount: "5000000",
      refundIndex: 0,
      ...patch,
    });
  return { app, sdk, config, context, history, request, submit };
}
describe("merchant-server refund signing", () => {
  it("requires a separate access token for all merchant routes", async () => {
    const { app, request, sdk } = setup();
    for (const bearer of ["", "wrong", "server-only-relayer-key"]) {
      expect(
        (await request("GET", "refund-context", undefined, bearer)).statusCode,
      ).toBe(401);
      expect((await request("POST", "refunds", {}, bearer)).statusCode).toBe(
        401,
      );
      expect(
        (
          await app.inject({
            url: "/api/merchant/orders",
            headers: { authorization: `Bearer ${bearer}` },
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(sdk.refund).not.toHaveBeenCalled();
    expect(sdk.getRefundContext).not.toHaveBeenCalled();
  });
  it("exposes balance/context and merchant-scoped orders without secrets", async () => {
    const { app, request, sdk } = setup();
    sdk.listOrders.mockResolvedValue([
      orderSettled,
      { ...orderSettled, merchantId: "0x" + "ff".repeat(32) },
    ]);
    const orders = await app.inject({
      url: "/api/merchant/orders",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(orders.json().orders).toHaveLength(1);
    const state = await request("GET");
    expect(state.json().context.refundBalance).toBe("25000000");
    expect(state.headers["cache-control"]).toBe("no-store");
    expect(state.headers["access-control-allow-origin"]).toBeUndefined();
    expect(state.body).not.toContain(key);
    expect(state.body).not.toContain("server-only-relayer-key");
  });
  it("signs a partial refund on the server and deduplicates the business request", async () => {
    const { submit, sdk, history, request } = setup();
    const response = await submit();
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      requestId,
      status: "pending",
      amount: "5000000",
      refund: { id: refundId },
    });
    expect(sdk.refund.mock.calls[0][0]).toMatchObject({
      amount: "5000000",
      refundIndex: 0,
      refundSignerPrivateKey: key,
      router: c.router,
      merchantId: c.merchantId,
    });
    expect(response.body).not.toContain(key);
    await submit();
    expect(sdk.refund).toHaveBeenCalledTimes(1);
    history[0].status = "settled";
    expect((await request("GET")).json().requests[0].status).toBe("settled");
    expect((await submit()).json().status).toBe("settled");
    expect(sdk.refund).toHaveBeenCalledTimes(1);
  });
  it("rejects changed request identity, invalid amounts and caller-selected signing fields", async () => {
    const { submit, sdk } = setup();
    for (const patch of [
      { amount: "0" },
      { amount: "-1" },
      { amount: "1.5" },
      { refundIndex: -1 },
      { requestId: "invalid" },
      { payer: c.payer },
      { router: c.router },
      { refundSignerPrivateKey: key },
    ])
      expect((await submit(patch)).statusCode).toBe(400);
    expect(sdk.refund).not.toHaveBeenCalled();
    await submit();
    expect((await submit({ amount: "6000000" })).statusCode).toBe(409);
    expect(sdk.refund).toHaveBeenCalledTimes(1);
  });
  it("checks remaining amount, stale index and available wallet balance before signing", async () => {
    const { submit, context, sdk } = setup();
    expect((await submit({ amount: "25000001" })).statusCode).toBe(422);
    expect((await submit({ refundIndex: 1 })).statusCode).toBe(409);
    context.refundBalance = "4999999";
    const low = await submit();
    expect(low.statusCode).toBe(422);
    expect(low.json().error.code).toBe("insufficient_refund_balance");
    expect(sdk.refund).not.toHaveBeenCalled();
    context.refundBalance = "5000000";
    expect((await submit()).statusCode).toBe(202);
  });
  it("rejects another merchant or a changed deployment before signing", async () => {
    const { request, submit, context, sdk } = setup();
    context.merchantId = "0x" + "dd".repeat(32);
    expect((await request("GET")).statusCode).toBe(409);
    expect((await submit()).statusCode).toBe(409);
    expect(sdk.refund).not.toHaveBeenCalled();
    sdk.getRefundContext.mockRejectedValue(
      new actualSdk.QuietpayApiError(404, "order_not_found", "internal secret"),
    );
    const missing = await submit();
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("internal secret");
  });
  it("blocks another request while one refund is pending", async () => {
    const { submit, sdk } = setup();
    await submit();
    expect((await submit({ requestId: secondId })).statusCode).toBe(409);
    expect(sdk.refund).toHaveBeenCalledTimes(1);
  });
  it("concurrent identical requests invoke the signer once", async () => {
    const { submit, sdk } = setup();
    const results = await Promise.all([submit(), submit()]);
    expect(results.map((r) => r.statusCode)).toContain(202);
    expect(sdk.refund).toHaveBeenCalledTimes(1);
  });
  it("retains an uncertain request across restart and reconciles it without re-signing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quietpay-refund-"));
    dirs.push(dir);
    const path = join(dir, "merchant.db");
    const first = setup(path);
    first.sdk.refund.mockRejectedValue(
      new Error("connection lost with secret " + key),
    );
    const unknown = await first.submit();
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json().status).toBe("unknown");
    expect(unknown.body).not.toContain(key);
    await first.app.close();
    open.splice(open.indexOf(first.app), 1);
    const next = setup(path);
    expect((await next.submit()).json().status).toBe("unknown");
    expect(next.sdk.refund).not.toHaveBeenCalled();
    expect((await next.submit({ requestId: secondId })).statusCode).toBe(409);
    next.history.push({
      id: refundId,
      orderId: c.orderId,
      amount: "5000000",
      refundIndex: 0,
      status: "settled",
      createdAt: 123,
    });
    expect((await next.submit()).json().status).toBe("settled");
    expect(next.sdk.refund).not.toHaveBeenCalled();
  });
  it("permits a new remaining refund only after the first has settled", async () => {
    const { submit, context, history, sdk } = setup();
    await submit();
    history[0].status = "settled";
    context.refunded = "5000000";
    context.refundIndex = 1;
    context.refundBalance = "20000000";
    const result = await submit({
      requestId: secondId,
      refundIndex: 1,
      amount: "20000000",
    });
    expect(result.statusCode).toBe(202);
    expect(sdk.refund).toHaveBeenCalledTimes(2);
  });
  it("keeps known failures stable and allows a deliberate new request", async () => {
    const { submit, sdk } = setup();
    sdk.refund.mockRejectedValueOnce(
      new actualSdk.QuietpayApiError(503, "relayer_paused", "paused"),
    );
    expect((await submit()).statusCode).toBe(503);
    expect((await submit()).json().status).toBe("failed");
    expect(sdk.refund).toHaveBeenCalledTimes(1);
    expect((await submit({ requestId: secondId })).statusCode).toBe(202);
  });
  it("leaves refund endpoints disabled without explicit server configuration", async () => {
    const app = buildApp(actualSdk, {
      baseUrl: "http://unused",
      apiKey: "key",
      merchantId: c.merchantId as `0x${string}`,
      webhookSecret: "secret",
    });
    open.push(app);
    expect((await app.inject({ url: "/api/merchant/orders" })).statusCode).toBe(
      503,
    );
  });
});

it("treats a server error after signing as uncertain even if it has a familiar error code", async () => {
  const { submit, sdk } = setup();
  sdk.refund.mockRejectedValue(
    new actualSdk.QuietpayApiError(500, "simulation_failed", "internal error"),
  );
  expect((await submit()).json().status).toBe("unknown");
  expect((await submit({ requestId: secondId })).statusCode).toBe(409);
  expect(sdk.refund).toHaveBeenCalledTimes(1);
});
