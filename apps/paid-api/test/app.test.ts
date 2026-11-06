import { describe, it, expect, vi } from "vitest";
import { buildServer } from "@quietpay/relayer/core";
import { setup, payer } from "../../../packages/facilitator/test/helpers.js";
import { registerFacilitator } from "../../../packages/facilitator/src/server.js";
import { buildPaidApi } from "../src/app.js";
import {
  encodeX402Header,
  decodeX402Header,
  X402Required,
  X402SettleResponse,
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  buildAgentAuthorization,
} from "@quietpay/shared";
async function running(
  options: { failFirst?: boolean; offline?: boolean; unknown?: boolean; hold?: boolean; defaults?: boolean } = {},
) {
  const e = setup();
  if (options.hold) e.state.hold = true;
  const facilitator = buildServer(e.svc);
  await registerFacilitator(facilitator, e.service);
  const facilitatorUrl = await facilitator.listen({
    host: "127.0.0.1",
    port: 0,
  });
  let calls = 0;
  const handler = vi.fn(() => {
    calls++;
    if (options.failFirst && calls === 1) throw new Error("resource failed");
    return { protected: "paid-data" };
  });
  const app = buildPaidApi({
    policies: e.policies,
    facilitatorUrl,
    apiKey: "test-key",
    handlers: options.defaults ? undefined : { "/v1/quote": handler },
    ...(options.offline
      ? {
          fetch: (async () => {
            throw new Error("network unavailable");
          }) as typeof fetch,
        }
      : options.unknown
        ? {
            fetch: (async () =>
              new Response(
                JSON.stringify({
                  success: false,
                  errorReason: "unexpected_settle_error",
                  transaction: "",
                  network: "eip155:1874",
                }),
                { status: 200 },
              )) as typeof fetch,
          }
        : {}),
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    ...e,
    handler,
    url,
    app,
    facilitator,
    headers: async () => ({
      "PAYMENT-SIGNATURE": encodeX402Header((await e.request()).paymentPayload),
    }),
    close: async () => {
      await app.close();
      await facilitator.close();
      e.service.stop();
      e.db.close();
    },
  };
}
describe("paid API over real HTTP", () => {
  it("advertises both priced resources with canonical v2 challenges and no data", async () => {
    const e = await running();
    try {
      for (const path of ["/v1/quote", "/v1/signal"]) {
        const res = await fetch(e.url + path);
        expect(res.status).toBe(402);
        const body = decodeX402Header(
          res.headers.get(PAYMENT_REQUIRED)!,
          X402Required,
        );
        expect(body.x402Version).toBe(2);
        expect(body.resource.url).toContain(path);
        expect(body.accepts[0]?.network).toBe("eip155:1874");
        expect(await res.json()).toEqual(body);
      }
      expect(e.handler).not.toHaveBeenCalled();
      expect(e.state.sent).toHaveLength(0);
    } finally {
      await e.close();
    }
  });
  it("delivers only after settlement and rejects completed-payment replay", async () => {
    const e = await running();
    try {
      const headers = await e.headers(),
        res = await fetch(e.url + "/v1/quote", { headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ protected: "paid-data" });
      expect(
        decodeX402Header(res.headers.get(PAYMENT_RESPONSE)!, X402SettleResponse)
          .success,
      ).toBe(true);
      await vi.waitFor(() =>
        expect(
          e.db.raw.prepare("SELECT delivered_at FROM x402_payments").get(),
        ).toMatchObject({ delivered_at: e.clock.t }),
      );
      const again = await fetch(e.url + "/v1/quote", { headers });
      expect(again.status).toBe(402);
      expect((await again.json()).error).toBe("payment_replayed");
      expect(e.handler).toHaveBeenCalledTimes(1);
      expect(e.state.sent).toHaveLength(1);
    } finally {
      await e.close();
    }
  });
  it("never delivers twice for concurrent identical requests", async () => {
    const e = await running();
    try {
      const headers = await e.headers();
      const responses = await Promise.all([
        fetch(e.url + "/v1/quote", { headers }),
        fetch(e.url + "/v1/quote", { headers }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 402]);
      expect(e.handler).toHaveBeenCalledTimes(1);
      expect(e.state.sent).toHaveLength(1);
      await Promise.all(responses.map((r) => r.text()));
    } finally {
      await e.close();
    }
  });
  it("returns a pending hash with no data, then delivers without charging twice", async () => {
    const e = await running({ hold: true });
    try {
      const headers = await e.headers();
      const pending = await fetch(e.url + "/v1/quote", { headers });
      expect(pending.status).toBe(402);
      const result = decodeX402Header(
        pending.headers.get(PAYMENT_RESPONSE)!,
        X402SettleResponse,
      );
      expect(result.errorReason).toBe("settlement_pending");
      expect(result.transaction).not.toBe("");
      expect(e.handler).not.toHaveBeenCalled();
      e.state.hold = false;
      expect((await fetch(e.url + "/v1/quote", { headers })).status).toBe(200);
      expect(e.state.prepared).toHaveLength(1);
    } finally {
      await e.close();
    }
  });
  it("allows one redelivery after resource execution fails following settlement", async () => {
    const e = await running({ failFirst: true });
    try {
      const headers = await e.headers();
      expect((await fetch(e.url + "/v1/quote", { headers })).status).toBe(503);
      await vi.waitFor(() =>
        expect(
          e.db.raw.prepare("SELECT lease_token FROM x402_payments").get(),
        ).toMatchObject({ lease_token: null }),
      );
      const retry = await fetch(e.url + "/v1/quote", { headers });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ protected: "paid-data" });
      expect((await fetch(e.url + "/v1/quote", { headers })).status).toBe(402);
      expect(e.state.sent).toHaveLength(1);
    } finally {
      await e.close();
    }
  });
  it("rejects malformed and wrong-resource payloads without invoking the resource", async () => {
    const e = await running();
    try {
      expect(
        (
          await fetch(e.url + "/v1/quote", {
            headers: { "PAYMENT-SIGNATURE": "garbage" },
          })
        ).status,
      ).toBe(400);
      expect(
        (await fetch(e.url + "/v1/signal", { headers: await e.headers() }))
          .status,
      ).toBe(400);
      expect(e.handler).not.toHaveBeenCalled();
      expect(e.state.sent).toHaveLength(0);
    } finally {
      await e.close();
    }
  });
  it("does not invite a new payment when settlement status is unknown", async () => {
    const e = await running({ offline: true });
    try {
      const response = await fetch(e.url + "/v1/quote", {
        headers: await e.headers(),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get(PAYMENT_REQUIRED)).toBeNull();
      expect((await response.json()).error.code).toBe("payment_status_unknown");
      expect(e.handler).not.toHaveBeenCalled();
    } finally {
      await e.close();
    }
  });
  it("does not request a fresh payment when a durable settlement claim has no known hash", async () => {
    const e = await running({ unknown: true });
    try {
      const response = await fetch(e.url + "/v1/quote", {
        headers: await e.headers(),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get(PAYMENT_REQUIRED)).toBeNull();
      expect(e.handler).not.toHaveBeenCalled();
    } finally {
      await e.close();
    }
  });
});

// Backend audit P4: the price is enforced at the paid API's HTTP edge, not only inside the facilitator service.
describe("paid API refuses a wrong price over real HTTP", () => {
  it("a validly signed authorization for less than the price, or an `accepted` that lowers it, never reaches the resource or the chain", async () => {
    const e = await running();
    try {
      const req = await e.request();
      const base = req.paymentPayload;
      const a = { ...base.payload.authorization, value: "1" };
      const signature = await payer.signTypedData(
        buildAgentAuthorization({
          from: a.from as `0x${string}`,
          to: a.to as `0x${string}`,
          value: 1n,
          validAfter: 0n,
          validBefore: BigInt(a.validBefore),
          nonce: a.nonce as `0x${string}`,
        }),
      );
      const cheap = { ...base, payload: { authorization: a, signature } };
      const lowered = { ...base, accepted: { ...base.accepted, amount: "1" } };
      for (const payload of [cheap, lowered]) {
        const res = await fetch(e.url + "/v1/quote", {
          headers: { "PAYMENT-SIGNATURE": encodeX402Header(payload) },
        });
        expect([400, 402]).toContain(res.status);
        expect(JSON.stringify(await res.json())).not.toContain("paid-data");
      }
      expect(e.handler).not.toHaveBeenCalled();
      expect(e.state.sent).toHaveLength(0);
      // the genuine price still works afterwards
      const ok = await fetch(e.url + "/v1/quote", { headers: await e.headers() });
      expect(ok.status).toBe(200);
      expect(e.handler).toHaveBeenCalledTimes(1);
    } finally {
      await e.close();
    }
  });
});

describe("paid API built-in demo responses", () => {
  it("serves the built-in quote after a confirmed payment when no handler is supplied", async () => {
    const e = await running({ defaults: true });
    try {
      const res = await fetch(e.url + "/v1/quote", { headers: await e.headers() });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ demo: true, symbol: "WBT/USDT", price: "1.000000" });
    } finally {
      await e.close();
    }
  });
});
