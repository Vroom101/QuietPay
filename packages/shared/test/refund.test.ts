import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { computeRefundNonce, computePayNonce, buildRefundAuthorization } from "../src/index.js";
import { orderSettled as order } from "../src/fixtures/index.js";
import type { Hex } from "viem";
const signer = privateKeyToAccount(("0x" + "d4".repeat(32)) as Hex);
const base = { merchantId: order.merchantId as Hex, orderId: order.id as Hex,
  payer: order.payer as Hex, amount: 5_000_000n, refundIndex: 0n };
describe("shared refund authorizations", () => {
  it("binds every refund field and uses a different namespace from payments", () => {
    const nonce = computeRefundNonce(base);
    for (const changed of [
      { merchantId: ("0x" + "01".repeat(32)) as Hex }, { orderId: ("0x" + "02".repeat(32)) as Hex },
      { payer: signer.address }, { amount: 5_000_001n }, { refundIndex: 1n },
    ]) expect(computeRefundNonce({ ...base, ...changed })).not.toBe(nonce);
    expect(computePayNonce({ ...base, payout: base.payer, value: base.amount, fee: 0n })).not.toBe(nonce);
  });
  it("signs the token domain with the router as the only receiver", async () => {
    const td = buildRefundAuthorization({ ...base, refundSigner: signer.address, router: order.checkout.router as Hex,
      validAfter: 1n, validBefore: 301n });
    expect(td.message).toMatchObject({ from: signer.address, to: order.checkout.router, value: base.amount, nonce: computeRefundNonce(base) });
    expect(await recoverTypedDataAddress({ ...td, signature: await signer.signTypedData(td) })).toBe(signer.address);
  });
});
