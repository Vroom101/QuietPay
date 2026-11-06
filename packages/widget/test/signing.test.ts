import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildCheckoutAuthorization, recoverCheckoutSigner } from "@quietpay/shared";
import { orderCreated } from "@quietpay/shared/fixtures";
import { signCheckout } from "../src/client.js";

describe("signCheckout", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = 1_800_000_100;

  it("uses the 5s back-dated / 300s window", async () => {
    const req = await signCheckout(account, orderCreated, now);
    expect(req.validAfter).toBe(now - 5);
    expect(req.validBefore).toBe(now + 300);
    expect(req.orderId).toBe(orderCreated.id);
    expect(req.payer).toBe(account.address);
  });

  it("signature matches the shared builder and recovers the payer", async () => {
    const req = await signCheckout(account, orderCreated, now);
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
    const expected = await account.signTypedData(buildCheckoutAuthorization(input));
    expect(req.signature as `0x${string}`).toBe(expected);
    expect(await recoverCheckoutSigner(input, req.signature as `0x${string}`)).toBe(account.address);
  });

  it("does not recover the payer if the amount is tampered with", async () => {
    const req = await signCheckout(account, orderCreated, now);
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
});
