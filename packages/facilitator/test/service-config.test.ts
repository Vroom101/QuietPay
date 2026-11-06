import { describe, it, expect } from "vitest";
import { FacilitatorService } from "../src/service.js";
import { setup } from "./helpers.js";

// Constructor validation: a facilitator must refuse to start on a policy or timing it cannot honour safely.
const ZERO = "0x" + "00".repeat(20);
const OTHER = "0x" + "99".repeat(20);

function variant(e: ReturnType<typeof setup>, change: (r: Record<string, unknown>, extra: Record<string, unknown>) => void) {
  const p = structuredClone(e.policies[0]!);
  change(p.requirements as unknown as Record<string, unknown>, p.requirements.extra as unknown as Record<string, unknown>);
  return p;
}

describe("FacilitatorService constructor validation", () => {
  it.each([
    ["negative settlement wait", { settlementWaitMs: -1 }],
    ["settlement wait above 60 s", { settlementWaitMs: 60_001 }],
    ["lease below 3 s", { leaseSeconds: 2 }],
    ["lease above 300 s", { leaseSeconds: 301 }],
  ])("rejects %s", (_name, opts) => {
    const e = setup();
    expect(() => new FacilitatorService(e.svc, { policies: e.policies, ...opts })).toThrow("Invalid settlement wait or delivery lease");
  });

  it("accepts the boundary values", () => {
    const e = setup();
    for (const opts of [{ settlementWaitMs: 0, leaseSeconds: 3 }, { settlementWaitMs: 60_000, leaseSeconds: 300 }])
      expect(new FacilitatorService(e.svc, { policies: e.policies, ...opts }).leaseSeconds).toBe(opts.leaseSeconds);
  });

  it.each([
    ["another network", (r: Record<string, unknown>) => (r.network = "eip155:1")],
    ["another asset", (r: Record<string, unknown>) => (r.asset = OTHER)],
    ["payTo the router", (r: Record<string, unknown>, _x: Record<string, unknown>) => (r.payTo = "ROUTER")],
    ["payTo the zero address", (r: Record<string, unknown>) => (r.payTo = ZERO)],
    ["another token name", (_r: Record<string, unknown>, x: Record<string, unknown>) => (x.name = "Other Token")],
    ["another token version", (_r: Record<string, unknown>, x: Record<string, unknown>) => (x.version = "2")],
  ])("rejects a policy with %s", (_name, change) => {
    const e = setup();
    const p = variant(e, (r, x) => change(r, x));
    if ((p.requirements as { payTo: string }).payTo === "ROUTER") (p.requirements as { payTo: string }).payTo = e.svc.cfg.router;
    expect(() => new FacilitatorService(e.svc, { policies: [p] })).toThrow("Policy does not match this USDT facilitator");
  });

  it("rejects a duplicate resource and an empty policy list", () => {
    const e = setup();
    expect(() => new FacilitatorService(e.svc, { policies: [e.policies[0]!, e.policies[0]!] })).toThrow("Duplicate paid resource");
    expect(() => new FacilitatorService(e.svc, { policies: [] })).toThrow("At least one paid resource is required");
  });

  it("refuses a payment database that belongs to a different chain, token or gas wallet", () => {
    const e = setup();
    e.svc.db.setSetting("x402_scope", JSON.stringify([1, "0x" + "11".repeat(20), "0x" + "22".repeat(20)]));
    expect(() => new FacilitatorService(e.svc, { policies: e.policies })).toThrow("different chain, token or gas wallet");
  });
});

describe("FacilitatorService edge branches", () => {
  it("maps a failure that is neither a PaymentError nor a ZodError to unexpected_verify_error without leaking its text", async () => {
    const { vi } = await import("vitest");
    const e = setup();
    const spy = vi.spyOn(e.service as unknown as { inspect: () => never }, "inspect").mockImplementation(() => {
      throw new Error("db at C:\secret\path exploded");
    });
    const res = await e.service.verify(await e.request(), "0x" + "01".repeat(32));
    spy.mockRestore();
    expect(res).toEqual({ isValid: false, invalidReason: "unexpected_verify_error" });
  });

  it("treats a missing assetTransferMethod as eip3009 on both the request and the policy side", async () => {
    const e = setup();
    const policy = structuredClone(e.policies[0]!);
    delete (policy.requirements.extra as { assetTransferMethod?: string }).assetTransferMethod;
    const service = new FacilitatorService(e.svc, { policies: [policy] });
    const req = structuredClone(await e.request());
    delete (req.paymentRequirements.extra as { assetTransferMethod?: string }).assetTransferMethod;
    delete (req.paymentPayload.accepted.extra as { assetTransferMethod?: string }).assetTransferMethod;
    expect((await service.verify(req, "0x" + "01".repeat(32))).isValid).toBe(true);
  });

  it("settle refuses while the relayer is paused locally and sends nothing", async () => {
    const e = setup();
    e.svc.setLocalPaused(true);
    const res = await e.service.settle(await e.request(), "0x" + "01".repeat(32));
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("relayer_paused");
    expect(e.db.raw.prepare("SELECT COUNT(*) n FROM x402_payments WHERE tx_hash IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("an unexpected failure while sending is reported as unexpected_settle_error, never with its message", async () => {
    const { vi } = await import("vitest");
    const e = setup();
    vi.spyOn(e.chain, "prepareTransfer").mockRejectedValue(new Error("rpc at http://10.0.0.5:8545 exploded"));
    const res = await e.service.settle(await e.request(), "0x" + "01".repeat(32));
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("unexpected_settle_error");
    expect(JSON.stringify(res)).not.toContain("10.0.0.5");
  });

  it("finish ignores a receipt for a payment that does not exist or is no longer settling", async () => {
    const e = setup();
    const finish = (e.service as unknown as { finish(id: string, hash: string, r: unknown): Promise<void> }).finish.bind(e.service);
    await expect(finish("no-such-payment", "0x" + "ab".repeat(32), { status: "success" })).resolves.toBeUndefined();
  });
});
