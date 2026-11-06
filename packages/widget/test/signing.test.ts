import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildCheckoutAuthorization, recoverCheckoutSigner } from "@quietpay/shared";
import { FIXTURE_ROUTER, makeOrder, orderCreated } from "@quietpay/shared/fixtures";
import { signCheckout } from "../src/client.js";

describe("signCheckout", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = 1_800_000_100;
  const expected = { router: FIXTURE_ROUTER, reviewedOrder: orderCreated };

  it("uses the 5s back-dated / 300s window", async () => {
    const req = await signCheckout(account, orderCreated, now, expected);
    expect(req.validAfter).toBe(now - 5);
    expect(req.validBefore).toBe(now + 300);
    expect(req.orderId).toBe(orderCreated.id);
    expect(req.payer).toBe(account.address);
  });

  it("signature matches the shared builder and recovers the payer", async () => {
    const req = await signCheckout(account, orderCreated, now, expected);
    const c = orderCreated.checkout;
    const input = {
      from: account.address,
      router: c.router as `0x${string}`,
      value: BigInt(c.value),
      nonce: c.nonce as `0x${string}`,
      validAfter: BigInt(req.validAfter),
      validBefore: BigInt(req.validBefore),
      chainId: c.chainId,
      token: c.token as `0x${string}`,
      domainName: c.domain.name,
      domainVersion: c.domain.version,
    };
    // Same bytes as signing the shared builder's output directly.
    const expectedSignature = await account.signTypedData(buildCheckoutAuthorization(input));
    expect(req.signature as `0x${string}`).toBe(expectedSignature);
    expect(await recoverCheckoutSigner(input, req.signature as `0x${string}`)).toBe(account.address);
  });

  it("does not recover the payer if the amount is tampered with", async () => {
    const req = await signCheckout(account, orderCreated, now, expected);
    const c = orderCreated.checkout;
    const recovered = await recoverCheckoutSigner(
      {
        from: account.address,
        router: c.router as `0x${string}`,
        value: BigInt(c.value) + 1n,
        nonce: c.nonce as `0x${string}`,
        validAfter: BigInt(req.validAfter),
        validBefore: BigInt(req.validBefore),
      },
      req.signature as `0x${string}`,
    );
    expect(recovered).not.toBe(account.address);
  });

  const checkout = orderCreated.checkout;
  const otherAddress = "0x" + "99".repeat(20);
  it.each([
    ["router", { ...orderCreated, checkout: { ...checkout, router: otherAddress } }],
    ["token", { ...orderCreated, checkout: { ...checkout, token: otherAddress } }],
    ["chain", { ...orderCreated, checkout: { ...checkout, chainId: 1 } }],
    ["domain name", { ...orderCreated, checkout: { ...checkout, domain: { ...checkout.domain, name: "Other" } } }],
    ["domain version", { ...orderCreated, checkout: { ...checkout, domain: { ...checkout.domain, version: "99" } } }],
    ["authorization value", { ...orderCreated, checkout: { ...checkout, value: "1" } }],
    ["relay fee", { ...orderCreated, fee: "1", checkout: { ...checkout, fee: "1" } }],
    ["amount with a valid nonce", makeOrder({ amount: "1" })],
    ["nonce", { ...orderCreated, checkout: { ...checkout, nonce: "0x" + "99".repeat(32) } }],
  ] as const)("rejects a changed %s before calling the signer", async (_field, order) => {
    const signTypedData = vi.fn(async () => { throw new Error("signer should not be called"); });
    await expect(signCheckout({ ...account, signTypedData }, order, now, expected))
      .rejects.toMatchObject({ code: "payment_details_changed" });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("signs for a separately configured DemoUSDT token and rejects incomplete or mismatched settings", async () => {
    const demo = { token: `0x${"88".repeat(20)}` as const, domainName: "Quietpay Demo USDT", domainVersion: "1" };
    const order = {
      ...orderCreated,
      checkout: { ...checkout, token: demo.token, domain: { name: demo.domainName, version: demo.domainVersion } },
    };
    const req = await signCheckout(account, order, now, { ...expected, ...demo });
    const recovered = await recoverCheckoutSigner({
      ...demo,
      from: req.payer as `0x${string}`,
      router: FIXTURE_ROUTER,
      value: BigInt(checkout.value),
      nonce: checkout.nonce as `0x${string}`,
      validAfter: BigInt(req.validAfter),
      validBefore: BigInt(req.validBefore),
    }, req.signature as `0x${string}`);
    expect(recovered).toBe(account.address);
    for (const config of [expected, { ...expected, token: demo.token }, { ...expected, ...demo, domainVersion: "2" }]) {
      const signTypedData = vi.fn(async () => { throw new Error("signer should not be called"); });
      await expect(signCheckout({ ...account, signTypedData }, order, now, config))
        .rejects.toMatchObject({ code: "payment_details_changed" });
      expect(signTypedData).not.toHaveBeenCalled();
    }
  });
});
