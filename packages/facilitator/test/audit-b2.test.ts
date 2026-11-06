import { describe, it, expect, vi, afterEach } from "vitest";
import { PaymentStore, type PaymentRow } from "../src/store.js";
import { setup, MERCHANT_ID } from "./helpers.js";

const base = (over: Partial<PaymentRow>): PaymentRow => ({
  id: "id-1",
  payer: "0x" + "11".repeat(20),
  nonce: "0x" + "01".repeat(32),
  merchant_id: MERCHANT_ID,
  resource: "https://api.test/v1/quote",
  pay_to: "0x" + "33".repeat(20),
  amount: "10000",
  fingerprint: "fp-1",
  request: "{}",
  status: "settling",
  tx_hash: null,
  error_reason: null,
  created_at: 1,
  delivered_at: null,
  delivery_attempts: 0,
  lease_token: null,
  lease_until: null,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

// Backend audit F4 / F5: replay protection is enforced by the database itself, not only by service logic.
describe("audit F4/F5: x402_payments uniqueness at the database level", () => {
  it("F4: the same payer + nonce cannot be inserted twice, whatever the id, resource or fingerprint", () => {
    const { db } = setup();
    const store = new PaymentStore(db);
    store.insert(base({ id: "a" }));
    expect(() => store.insert(base({ id: "b", fingerprint: "other", resource: "https://api.test/v1/signal" }))).toThrow(/UNIQUE/i);
    // a different payer may reuse the nonce, and the same payer may use a different nonce
    store.insert(base({ id: "c", payer: "0x" + "22".repeat(20) }));
    store.insert(base({ id: "d", nonce: "0x" + "02".repeat(32) }));
    expect(db.raw.prepare("SELECT COUNT(*) n FROM x402_payments").get()).toEqual({ n: 3 });
  });

  it("F5: one transaction hash cannot settle two payments; several unsent rows (null hash) are fine", () => {
    const { db } = setup();
    const store = new PaymentStore(db);
    const hash = "0x" + "ab".repeat(32);
    store.insert(base({ id: "a", tx_hash: hash }));
    expect(() => store.insert(base({ id: "b", nonce: "0x" + "02".repeat(32), tx_hash: hash }))).toThrow(/UNIQUE/i);
    store.insert(base({ id: "c", nonce: "0x" + "03".repeat(32) }));
    store.insert(base({ id: "d", nonce: "0x" + "04".repeat(32) }));
    expect(db.raw.prepare("SELECT COUNT(*) n FROM x402_payments").get()).toEqual({ n: 3 });
  });

  it("F5: claiming an already-claimed foreign tx hash is refused by the store (returns false, state unchanged)", () => {
    const { db } = setup();
    const store = new PaymentStore(db);
    const hash = "0x" + "cd".repeat(32);
    store.insert(base({ id: "a" }));
    store.insert(base({ id: "b", nonce: "0x" + "02".repeat(32) }));
    expect(store.settledExternal("a", { hash, logIndex: 1, blockNumber: 5n })).toBe(true);
    expect(store.settledExternal("b", { hash, logIndex: 1, blockNumber: 5n })).toBe(false);
    expect(store.get("b")!.status).toBe("settling");
  });
});

// Backend audit F18: the facilitator never fetches a URL taken from a request, a payload or a resource, so there is no
// SSRF surface in it. The only outbound traffic is the chain RPC, which goes through the injected chain port.
describe("audit F18: no outbound HTTP from verify and settle", () => {
  it("settling a payment whose payload and resource carry hostile URLs makes no fetch", async () => {
    const e = setup();
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outbound HTTP expected"));
    const req = structuredClone(await e.request()); // the request shares the policy's resource object: never mutate it
    (req.paymentPayload.resource as { url: string }).url = "http://169.254.169.254/latest/meta-data/";
    expect((await e.service.verify(req, MERCHANT_ID)).isValid).toBe(false); // the policy lookup refuses the unknown resource
    const good = await e.request(2);
    const res = await e.service.settle(good, MERCHANT_ID);
    expect(res.success).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
