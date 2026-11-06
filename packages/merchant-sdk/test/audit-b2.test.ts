import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
  PAYMENT_SIGNATURE,
  encodeX402Header,
  makePaidPolicies,
  type X402Payload,
} from "@quietpay/shared";
import { WebhookVerificationError, verifyWebhook } from "../src/index.js";
import { paywall } from "../src/paywall.js";

// ---------------------------------------------------------------- S5 / S8: webhook verification
const SECRET = "whsec_audit_secret_value";
const NOW = 1_800_000_000;
const body = JSON.stringify({ id: "evt_0123456789abcdef", type: "payment.settled", createdAt: NOW, data: { orderId: "0x" + "ab".repeat(32), merchantId: "0x" + "cd".repeat(32), amount: "25000000", fee: "50000", payout: "0x2222222222222222222222222222222222222222", payer: "0x1111111111111111111111111111111111111111", txHash: "0x" + "ee".repeat(32) } });
const sign = (b: string, t = NOW, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${b}`).digest("hex")}`;
const attempt = (header: string, extra: Record<string, unknown> = {}) =>
  verifyWebhook({ secret: SECRET, body, signatureHeader: header, nowSeconds: NOW, ...extra });

describe("audit S5: signature comparison is exact and never throws a RangeError", () => {
  const good = sign(body);
  const hex = good.split("v1=")[1]!;
  it("accepts the genuine signature", () => {
    expect(() => attempt(good)).not.toThrow();
  });
  it("rejects a change to ANY single character of the signature (all 64 positions)", () => {
    for (let i = 0; i < hex.length; i++) {
      const flipped = hex.slice(0, i) + (hex[i] === "0" ? "1" : "0") + hex.slice(i + 1);
      expect(() => attempt(`t=${NOW},v1=${flipped}`), `position ${i}`).toThrow(WebhookVerificationError);
    }
  });
  it("rejects shorter, longer, empty, non-hex and multi-value signatures with WebhookVerificationError (not a crash)", () => {
    // (several v1= values are accepted when ONE of them is valid: that is secret rotation, not a bypass)
    for (const v1 of [hex.slice(0, 62), hex + "00", "", "zz".repeat(32), hex.toUpperCase() + "x", `${hex.slice(0, 63)}0,v1=${hex.slice(0, 62)}`]) {
      let err: unknown;
      try {
        attempt(`t=${NOW},v1=${v1}`);
      } catch (e) {
        err = e;
      }
      expect(err, `v1=${v1.slice(0, 8)}...`).toBeInstanceOf(WebhookVerificationError);
    }
  });
});

describe("audit S8: replayed webhook ids", () => {
  const good = sign(body);
  it("calls isDuplicate with the event id only after the signature checked out, and rejects a duplicate", () => {
    const seen = new Set<string>(["evt_0123456789abcdef"]);
    const isDuplicate = vi.fn((id: string) => seen.has(id));
    expect(() => attempt(good, { isDuplicate })).toThrow(/duplicate/i);
    expect(isDuplicate).toHaveBeenCalledWith("evt_0123456789abcdef");
    // an unauthenticated caller never reaches the dedupe store
    isDuplicate.mockClear();
    expect(() => attempt(`t=${NOW},v1=${"0".repeat(64)}`, { isDuplicate })).toThrow(WebhookVerificationError);
    expect(isDuplicate).not.toHaveBeenCalled();
  });
  it("accepts a first delivery, and the hook can record it", () => {
    const seen = new Set<string>();
    const isDuplicate = (id: string) => (seen.has(id) ? true : (seen.add(id), false));
    expect(attempt(good, { isDuplicate }).id).toBe("evt_0123456789abcdef");
    expect(() => attempt(good, { isDuplicate })).toThrow(/duplicate/i);
  });
  it("without the hook verification stays stateless (documented receiver duty)", () => {
    expect(() => attempt(good)).not.toThrow();
    expect(() => attempt(good)).not.toThrow();
  });
});

// ---------------------------------------------------------------- paywall.ts
const MERCHANT = ("0x" + "ab".repeat(32)) as `0x${string}`;
const policies = makePaidPolicies({
  baseUrl: "https://api.test",
  merchantId: MERCHANT,
  payTo: "0x3333333333333333333333333333333333333333",
  asset: "0x4444444444444444444444444444444444444444",
  chainId: 1874,
  name: "Tether USD",
  version: "1",
});
const policy = policies[0]!;
const payer = "0x1111111111111111111111111111111111111111";
const payload = (): X402Payload => ({
  x402Version: 2,
  resource: policy.resource,
  accepted: policy.requirements,
  payload: {
    signature: ("0x" + "11".repeat(65)) as `0x${string}`,
    authorization: { from: payer, to: policy.requirements.payTo, value: policy.requirements.amount, validAfter: "0", validBefore: "9999999999", nonce: ("0x" + "01".repeat(32)) as `0x${string}` },
  },
});
const header = (p: X402Payload = payload()) => ({ [PAYMENT_SIGNATURE]: encodeX402Header(p) });

type Reply = { ok?: boolean; status?: number; json?: unknown; throws?: boolean };
function facilitator(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const r = replies[path] ?? { ok: false, status: 404 };
    if (r.throws) throw new Error("connection refused");
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const settled = { success: true, transaction: "0x" + "ee".repeat(32), network: policy.requirements.network, payer };
const claim = { success: true, paymentId: "0x" + "aa".repeat(32), leaseToken: "lease-1", leaseSeconds: 30 };

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});
async function start(replies: Record<string, Reply>, status = 200) {
  const f = facilitator(replies);
  const mw = paywall({ facilitatorUrl: "https://facilitator.test", apiKey: "k", policy, fetch: f.fetchFn, timeoutMs: 500 });
  const delivered = vi.fn();
  server = createServer((req, res) => {
    void mw(req, res, () => {
      delivered();
      res.statusCode = status;
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...f, delivered, url };
}
const ok = { "/settle": { json: settled }, "/v1/x402/delivery/claim": { json: claim }, "/v1/x402/delivery/complete": { json: { success: true } }, "/v1/x402/delivery/release": { json: { success: true } }, "/v1/x402/delivery/renew": { json: { success: true } } };

describe("audit P4 + paywall.ts: the resource runs only after settlement and an exclusive lease", () => {
  it("no payment header: 402 with a v2 challenge and no data, facilitator untouched", async () => {
    const s = await start(ok);
    const res = await fetch(s.url + "/v1/quote");
    expect(res.status).toBe(402);
    expect(res.headers.get(PAYMENT_REQUIRED)).toBeTruthy();
    expect(await res.json()).toMatchObject({ x402Version: 2, error: "payment_required" });
    expect(s.delivered).not.toHaveBeenCalled();
    expect(s.calls).toEqual([]);
  });

  it("wrong method or wrong path: 400 invalid_resource, nothing settled", async () => {
    const s = await start(ok);
    expect((await fetch(s.url + "/v1/quote", { method: "POST", headers: header() })).status).toBe(400);
    expect((await fetch(s.url + "/v1/signal", { headers: header() })).status).toBe(400);
    expect((await fetch(s.url + "/v1/quote?x=1", { headers: header() })).status).toBe(400);
    expect(s.calls).toEqual([]);
  });

  it("malformed header or a payload for another resource: 400 invalid_payload, nothing settled", async () => {
    const s = await start(ok);
    expect((await fetch(s.url + "/v1/quote", { headers: { [PAYMENT_SIGNATURE]: "not-base64-json" } })).status).toBe(400);
    const other = payload();
    other.resource = { ...other.resource, url: "https://api.test/v1/signal" };
    expect((await fetch(s.url + "/v1/quote", { headers: header(other) })).status).toBe(400);
    expect(s.calls).toEqual([]);
    expect(s.delivered).not.toHaveBeenCalled();
  });

  it("settled + claimed: delivers once, returns the settlement header and completes the lease", async () => {
    const s = await start(ok);
    const res = await fetch(s.url + "/v1/quote", { headers: header() });
    expect(res.status).toBe(200);
    expect(res.headers.get(PAYMENT_RESPONSE)).toBeTruthy();
    await vi.waitFor(() => expect(s.calls).toContain("/v1/x402/delivery/complete"));
    expect(s.delivered).toHaveBeenCalledTimes(1);
    expect(s.calls.indexOf("/settle")).toBeLessThan(s.calls.indexOf("/v1/x402/delivery/claim"));
  });

  it("a non-2xx resource response releases the lease instead of completing it", async () => {
    const s = await start(ok, 500);
    expect((await fetch(s.url + "/v1/quote", { headers: header() })).status).toBe(500);
    await vi.waitFor(() => expect(s.calls).toContain("/v1/x402/delivery/release"));
    expect(s.calls).not.toContain("/v1/x402/delivery/complete");
  });

  it("settle refused (replayed / wrong price): 402 with the reason, the resource never runs and nothing is claimed", async () => {
    for (const errorReason of ["payment_replayed", "invalid_exact_evm_payload_authorization_value", "settlement_pending"]) {
      const s = await start({ ...ok, "/settle": { json: { success: false, errorReason, transaction: errorReason === "settlement_pending" ? "0x" + "ee".repeat(32) : "", network: policy.requirements.network } } });
      const res = await fetch(s.url + "/v1/quote", { headers: header() });
      expect(res.status, errorReason).toBe(402);
      expect((await res.json()).error).toBe(errorReason);
      expect(s.delivered).not.toHaveBeenCalled();
      expect(s.calls).toEqual(["/settle"]);
      server?.closeAllConnections();
      server?.close();
    }
  });

  it("status unknown or parked (unexpected error, unresolved settlement, facilitator down): 503 and NO invitation to pay again", async () => {
    const down = { "/settle": { throws: true } };
    const unexpected = { "/settle": { json: { success: false, errorReason: "unexpected_settle_error", transaction: "", network: policy.requirements.network } } };
    const unresolved = { "/settle": { json: { success: false, errorReason: "settlement_unresolved", transaction: "", network: policy.requirements.network } } };
    const http500 = { "/settle": { ok: false, status: 500 } };
    for (const replies of [down, unexpected, unresolved, http500]) {
      const s = await start({ ...ok, ...replies });
      const res = await fetch(s.url + "/v1/quote", { headers: header() });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("payment_status_unknown");
      expect(res.headers.get(PAYMENT_REQUIRED)).toBeNull();
      expect(s.delivered).not.toHaveBeenCalled();
      expect(s.calls).not.toContain("/v1/x402/delivery/claim");
      server?.closeAllConnections();
      server?.close();
    }
  });

  it("a settlement for another network or another payer is rejected before the claim", async () => {
    for (const bad of [{ ...settled, network: "eip155:1" }, { ...settled, payer: "0x2222222222222222222222222222222222222222" }, { ...settled, transaction: "" }]) {
      const s = await start({ ...ok, "/settle": { json: bad } });
      const res = await fetch(s.url + "/v1/quote", { headers: header() });
      expect(res.status).toBe(503);
      expect(s.delivered).not.toHaveBeenCalled();
      expect(s.calls).not.toContain("/v1/x402/delivery/claim");
      server?.closeAllConnections();
      server?.close();
    }
  });

  it("a refused delivery claim (already delivered / leased) is a 402 and the resource never runs", async () => {
    const s = await start({ ...ok, "/v1/x402/delivery/claim": { json: { success: false, errorReason: "payment_replayed" } } });
    const res = await fetch(s.url + "/v1/quote", { headers: header() });
    expect(res.status).toBe(402);
    expect(s.delivered).not.toHaveBeenCalled();
  });

  it("sends the API key as a bearer token and refuses redirects from the facilitator", async () => {
    const seen: RequestInit[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return { ok: true, status: 200, json: async () => settled } as unknown as Response;
    }) as unknown as typeof fetch;
    const mw = paywall({ facilitatorUrl: "https://facilitator.test///", apiKey: "secret-key", policy, fetch: fetchFn });
    server = createServer((req, res) => void mw(req, res, () => res.end("ok")));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/quote`, { headers: header() });
    expect((seen[0]!.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(seen[0]!.redirect).toBe("error");
  });
});

describe("mutation kill P8: a refused delivery claim never runs the resource", () => {
  it("settled but claim refused (already delivered): 402 payment_replayed, resource not run", async () => {
    const s = await start({ ...ok, "/v1/x402/delivery/claim": { json: { success: false, errorReason: "payment_replayed" } } });
    const res = await fetch(s.url + "/v1/quote", { headers: header() });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("payment_replayed");
    expect(s.delivered).not.toHaveBeenCalled();
  });

  it("a refused claim is refused even when it still carries a payment id and lease (success=false is authoritative)", async () => {
    const s = await start({ ...ok, "/v1/x402/delivery/claim": { json: { ...claim, success: false, errorReason: "payment_replayed" } } });
    const res = await fetch(s.url + "/v1/quote", { headers: header() });
    expect(res.status).toBe(402);
    expect(s.delivered).not.toHaveBeenCalled();
  });
});
