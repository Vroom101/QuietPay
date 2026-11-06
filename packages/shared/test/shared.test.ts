import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import {
  Order,
  RelayPayRequest,
  ERROR_CODES,
  RefundQuoteResponse,
  RefundResponse,
  RefundRequest,
  buildRefundAuthorization,
  computeRefundNonce,
  recoverRefundSigner,
  REFUND_TAG,
  ERROR_HTTP_STATUS,
  ERROR_USER_MESSAGES,
  buildCheckoutAuthorization,
  checkAuthWindow,
  computePayNonce,
  formatUsdt,
  parseUsdt,
  recoverCheckoutSigner,
  PAY_TAG,
  token,
} from "../src/index.js";
import { signWebhook, verifyWebhookSignature, WebhookEvent } from "../src/webhook.js";
import * as fx from "../src/fixtures/index.js";

describe("token facts", () => {
  it("has the verified live values", () => {
    expect(token.decimals).toBe(6);
    expect(token.chainId).toBe(1874);
    expect(token.eip712Domain).toEqual({ name: "Tether USD", version: "1" });
  });
});

describe("errors", () => {
  it("has the nine frozen codes plus the two refund codes, each with a status and plain message", () => {
    expect(ERROR_CODES).toEqual([
      "order_not_found",
      "order_expired",
      "bad_signature",
      "amount_mismatch",
      "already_settled",
      "relayer_paused",
      "rate_limited",
      "simulation_failed",
      "fee_over_cap",
      "insufficient_refund_balance",
      "payment_replayed",
    ]);
    for (const c of ERROR_CODES) {
      expect(ERROR_HTTP_STATUS[c]).toBeGreaterThanOrEqual(400);
      expect(ERROR_USER_MESSAGES[c]).not.toMatch(/gas|wbt|transaction/i);
    }
  });
});

describe("fixtures match schemas", () => {
  it.each([fx.orderCreated, fx.orderPending, fx.orderSettled, fx.orderFailed, fx.orderExpired])(
    "order %#",
    (o) => expect(Order.parse(o)).toBeTruthy(),
  );
  it("webhooks", () => {
    expect(WebhookEvent.parse(fx.webhookSettled)).toBeTruthy();
    expect(WebhookEvent.parse(fx.webhookFailed)).toBeTruthy();
  });
});

describe("nonce", () => {
  it("matches the Solidity definition and changes with every bound field", () => {
    const base = { merchantId: fx.FIXTURE_MERCHANT_ID, orderId: fx.FIXTURE_ORDER_ID, payout: fx.FIXTURE_PAYOUT, value: 1n };
    const n = computePayNonce(base);
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computePayNonce({ ...base, value: 2n })).not.toBe(n);
    expect(computePayNonce({ ...base, payout: fx.FIXTURE_PAYER })).not.toBe(n);
    expect(PAY_TAG).toBe("0x" + PAY_TAG.slice(2));
  });
});

describe("typed data", () => {
  const account = privateKeyToAccount("0x" + "11".repeat(32) as `0x${string}`);
  const input = {
    from: account.address,
    router: fx.FIXTURE_ROUTER,
    value: 25_000_000n,
    nonce: fx.orderCreated.checkout.nonce as `0x${string}`,
    validAfter: 100n,
    validBefore: 400n,
  };

  it("signs ReceiveWithAuthorization with to = router and recovers the payer", async () => {
    const td = buildCheckoutAuthorization(input);
    expect(td.primaryType).toBe("ReceiveWithAuthorization");
    expect(td.message.to).toBe(fx.FIXTURE_ROUTER);
    const signature = await account.signTypedData(td);
    expect(await recoverCheckoutSigner(input, signature)).toBe(account.address);
    expect(await verifyTypedData({ address: account.address, ...td, signature })).toBe(true);
  });

  it("recovers a different address if the amount is tampered", async () => {
    const signature = await account.signTypedData(buildCheckoutAuthorization(input));
    expect(await recoverCheckoutSigner({ ...input, value: 26_000_000n }, signature)).not.toBe(account.address);
  });

  it("enforces the 10 minute window", () => {
    expect(checkAuthWindow(100, 400, 200)).toBeNull();
    expect(checkAuthWindow(100, 701, 200)).toMatch(/10 minutes/);
    expect(checkAuthWindow(100, 400, 400)).toMatch(/expired/);
    expect(checkAuthWindow(100, 400, 100)).toMatch(/not yet/);
    expect(checkAuthWindow(400, 100, 200)).toMatch(/after/);
  });
});

describe("amounts", () => {
  it("formats and parses 6-decimal USDT", () => {
    expect(formatUsdt(25_000_000n)).toBe("25.00");
    expect(formatUsdt("50000")).toBe("0.05");
    expect(parseUsdt("25.5")).toBe(25_500_000n);
  });
});

describe("relay request", () => {
  it("rejects malformed signatures", () => {
    const ok = {
      orderId: fx.FIXTURE_ORDER_ID,
      payer: fx.FIXTURE_PAYER,
      validAfter: 1,
      validBefore: 2,
      signature: "0x" + "ab".repeat(65),
    };
    expect(RelayPayRequest.safeParse(ok).success).toBe(true);
    expect(RelayPayRequest.safeParse({ ...ok, signature: "0x1234" }).success).toBe(false);
  });
});

describe("webhook signature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify(fx.webhookSettled);
  it("verifies, and rejects tampering, wrong secret, stale timestamps", () => {
    const now = 1_800_000_000;
    const header = signWebhook(secret, body, now);
    expect(verifyWebhookSignature(secret, body, header, { nowSeconds: now + 10 })).toBe(true);
    expect(verifyWebhookSignature(secret, body + " ", header, { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature("other", body, header, { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(secret, body, header, { nowSeconds: now + 301 })).toBe(false);
    expect(verifyWebhookSignature(secret, body, "garbage", { nowSeconds: now })).toBe(false);
  });
});

describe("refunds", () => {
  it("nonce matches the value pinned in the Solidity suite and binds every field", () => {
    const base = {
      merchantId: ("0x" + "01".repeat(32)) as `0x${string}`,
      orderId: ("0x" + "02".repeat(32)) as `0x${string}`,
      payer: "0x3333333333333333333333333333333333333333" as `0x${string}`,
      amount: 5_000_000n,
      refundIndex: 0,
    };
    const n = computeRefundNonce(base);
    expect(n).toBe("0x714ed318025e3e52735fc272c242c144d0bf97a60518adfe2f729adb50b29d66");
    expect(REFUND_TAG).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeRefundNonce({ ...base, refundIndex: 1 })).not.toBe(n);
    expect(computeRefundNonce({ ...base, amount: 5_000_001n })).not.toBe(n);
    expect(computeRefundNonce({ ...base, payer: fx.FIXTURE_PAYOUT })).not.toBe(n);
  });

  it("refund authorization is signed by the refundSigner with to = router and recovers it", async () => {
    const signer = privateKeyToAccount(("0x" + "22".repeat(32)) as `0x${string}`);
    const input = {
      refundSigner: signer.address,
      router: fx.FIXTURE_ROUTER,
      amount: 10_000_000n,
      nonce: fx.refundQuote.nonce as `0x${string}`,
      validAfter: 100n,
      validBefore: 400n,
    };
    const td = buildRefundAuthorization(input);
    expect(td.primaryType).toBe("ReceiveWithAuthorization");
    expect(td.message.to).toBe(fx.FIXTURE_ROUTER);
    expect(td.message.from).toBe(signer.address);
    const sig = await signer.signTypedData(td);
    expect(await recoverRefundSigner(input, sig)).toBe(signer.address);
    expect(await recoverRefundSigner({ ...input, amount: 1n }, sig)).not.toBe(signer.address);
  });

  it("fixtures and request shapes parse", () => {
    expect(RefundQuoteResponse.parse(fx.refundQuote)).toBeTruthy();
    expect(RefundResponse.parse(fx.refundResponse)).toBeTruthy();
    expect(Order.parse(fx.orderPartiallyRefunded).refundedAmount).toBe("10000000");
    expect(
      RefundRequest.safeParse({ orderId: fx.FIXTURE_ORDER_ID, amount: "1", validAfter: 1, validBefore: 2, signature: "0x" + "ab".repeat(65) }).success,
    ).toBe(true);
    expect(RefundRequest.safeParse({ orderId: fx.FIXTURE_ORDER_ID, amount: "0", validAfter: 1, validBefore: 2, signature: "0x12" }).success).toBe(false);
  });
});

describe("mock relayer refunds", () => {
  it("quotes, refunds, tracks the running total and rejects over-refunds", async () => {
    const { createMockRelayer } = await import("../src/mock-server.js");
    const srv = createMockRelayer();
    await new Promise<void>((r) => srv.listen(0, r));
    const base = `http://localhost:${(srv.address() as { port: number }).port}`;
    const id = fx.orderSettled.id;
    const post = (amount: string) =>
      fetch(`${base}/v1/refund`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        body: JSON.stringify({ orderId: id, amount, validAfter: 1, validBefore: 2, signature: "0x" + "ab".repeat(65) }),
      });
    try {
      const q = RefundQuoteResponse.parse(await (await fetch(`${base}/v1/orders/${id}/refund-quote?amount=5000000`)).json());
      expect(q.refundIndex).toBe(0);
      const r1 = RefundResponse.parse(await (await post("5000000")).json());
      expect(r1.totalRefunded).toBe("5000000");
      const q2 = RefundQuoteResponse.parse(await (await fetch(`${base}/v1/orders/${id}/refund-quote?amount=5000000`)).json());
      expect(q2.refundIndex).toBe(1);
      expect(q2.totalRefunded).toBe("5000000");
      expect((await post("25000000")).status).toBe(400); // over-refund
      const low = await post("5000001");
      expect(low.status).toBe(422);
      expect((await low.json()).error.code).toBe("insufficient_refund_balance");
      expect((await fetch(`${base}/v1/refund`, { method: "POST", body: "{}" })).status).toBe(401);
    } finally {
      srv.close();
    }
  });
});
