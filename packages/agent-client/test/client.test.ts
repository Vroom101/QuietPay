import { describe, it, expect, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  buildAgentAuthorization,
  decodeX402Header,
  encodeX402Header,
  X402Payload,
} from "@quietpay/shared";
import { createAgent, AgentError, type AgentOptions } from "../src/index.js";
const account = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`);
const asset = "0x2222222222222222222222222222222222222222",
  payTo = "0x3333333333333333333333333333333333333333";
const hash = "0x" + "ab".repeat(32);
const url = "https://api.example/v1/quote";
const requirement = {
  scheme: "exact",
  network: "eip155:1874",
  asset,
  amount: "10000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {
    name: "Tether USD",
    version: "1",
    assetTransferMethod: "eip3009",
    paymentFlow: "upfront",
  },
};
const challenge = (patch: Record<string, unknown> = {}, resource = url) =>
  new Response("{}", {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": encodeX402Header({
        x402Version: 2,
        resource: { url: resource },
        accepts: [{ ...requirement, ...patch }],
      }),
    },
  });
const success = (patch: Record<string, unknown> = {}, status = 200) =>
  new Response('{"demo":true}', {
    status,
    headers: {
      "PAYMENT-RESPONSE": encodeX402Header({
        success: true,
        transaction: hash,
        payer: account.address,
        network: "eip155:1874",
        ...patch,
      }),
    },
  });
function setup(
  handler?: (url: string, init?: RequestInit) => Promise<Response>,
  patch: Partial<AgentOptions> = {},
) {
  const sign = vi.fn((data: ReturnType<typeof buildAgentAuthorization>) =>
    account.signTypedData(data),
  );
  const fetcher = vi.fn(
    handler ??
      (async (_url, init) =>
        new Headers(init?.headers).has("PAYMENT-SIGNATURE")
          ? success()
          : challenge()),
  );
  const options: AgentOptions = {
    signer: { address: account.address, signTypedData: sign },
    chainId: 1874,
    asset,
    domainName: "Tether USD",
    domainVersion: "1",
    allowedOrigins: ["https://api.example"],
    allowedPayTo: [payTo],
    perCallLimit: 20000n,
    sessionBudget: 30000n,
    explorerUrl: "https://scan.example",
    fetch: fetcher as typeof fetch,
    ...patch,
  };
  return { agent: createAgent(options), fetcher, sign, options };
}
describe("guarded agent fetch", () => {
  it("returns unpaid responses without signing", async () => {
    const { agent, sign } = setup(async () => new Response("free"));
    expect(await (await agent.fetch(url)).text()).toBe("free");
    expect(sign).not.toHaveBeenCalled();
  });
  it("signs exact authorization and records a paid receipt", async () => {
    const { agent, sign, fetcher } = setup();
    expect((await agent.fetch(url)).status).toBe(200);
    const payload = decodeX402Header(
      new Headers(fetcher.mock.calls[1][1]?.headers).get("PAYMENT-SIGNATURE")!,
      X402Payload,
    );
    const data = sign.mock.calls[0][0];
    expect(
      await recoverTypedDataAddress({
        ...data,
        signature: payload.payload.signature as `0x${string}`,
      }),
    ).toBe(account.address);
    expect(data.message.to).toBe(payTo);
    expect(data.message.value).toBe(10000n);
    expect(payload.resource.url).toBe(url);
    expect(BigInt(payload.payload.authorization.validBefore)).toBeGreaterThan(
      BigInt(Math.floor(Date.now() / 1000)),
    );
    expect(agent.reservedAmount).toBe(10000n);
    expect(agent.payments[0]).toMatchObject({
      delivered: true,
      status: "settled",
      transaction: hash,
      explorerUrl: `https://scan.example/tx/${hash}`,
    });
    expect(
      fetcher.mock.calls.every(
        (call) =>
          call[1]?.redirect === "error" && call[1]?.credentials === "omit",
      ),
    ).toBe(true);
  });
  it.each([
    { amount: "20001" },
    { amount: "40000" },
    { network: "eip155:1" },
    { payTo: asset },
    { asset: payTo },
    { extra: { name: "Evil", version: "1" } },
  ])("refuses an unsafe requirement before signing: %j", async (patch) => {
    const { agent, sign } = setup(async () => challenge(patch));
    await expect(agent.fetch(url)).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    expect(sign).not.toHaveBeenCalled();
  });
  it.each([
    "https://evil.example/",
    "http://api.example/v1/quote",
    "https://user:pass@api.example/v1/quote",
    url + "#fragment",
    "https://api.example:444/v1/quote",
  ])("blocks disallowed URL %s before request", async (value) => {
    const { agent, sign, fetcher } = setup();
    await expect(agent.fetch(value)).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
  it("rejects a wrong resource or malformed header before signing", async () => {
    for (const response of [
      challenge({}, "https://api.example/v1/signal"),
      new Response("", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": "invalid" },
      }),
    ]) {
      const { agent, sign } = setup(async () => response);
      await expect(agent.fetch(url)).rejects.toMatchObject({
        code: "invalid_payment",
      });
      expect(sign).not.toHaveBeenCalled();
    }
  });
  it("reserves concurrent calls atomically against session budget", async () => {
    const { agent, sign } = setup(async (value, init) =>
      new Headers(init?.headers).has("PAYMENT-SIGNATURE")
        ? success()
        : challenge({ amount: "20000" }, value),
    );
    const results = await Promise.allSettled([
      agent.fetch(url),
      agent.fetch("https://api.example/v1/signal"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(agent.reservedAmount).toBe(20000n);
  });
  it("concurrent calls to the same resource create one authorization", async () => {
    const { agent, sign } = setup();
    const results = await Promise.allSettled([
      agent.fetch(url),
      agent.fetch(url),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it("retains unknown payment budget and retries the identical signature", async () => {
    const headers: string[] = [];
    const { agent, sign } = setup(async (_value, init) => {
      const header = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (!header) return challenge();
      headers.push(header);
      if (headers.length === 1)
        throw new Error("connection lost after accepting payment");
      return success();
    });
    await expect(agent.fetch(url)).rejects.toMatchObject({
      code: "payment_status_unknown",
    });
    expect(agent.reservedAmount).toBe(10000n);
    expect(agent.payments[0].status).toBe("unknown");
    await expect(agent.fetch(url)).rejects.toMatchObject({
      code: "payment_pending",
    });
    expect((await agent.retry(agent.payments[0].id)).status).toBe(200);
    expect(headers[0]).toBe(headers[1]);
    expect(sign).toHaveBeenCalledTimes(1);
    await expect(agent.retry(agent.payments[0].id)).rejects.toBeInstanceOf(
      AgentError,
    );
  });
  it("pending settlement keeps its hash and retries without a new charge", async () => {
    let sent = 0;
    const { agent, sign } = setup(async (_value, init) => {
      if (!new Headers(init?.headers).has("PAYMENT-SIGNATURE"))
        return challenge();
      return ++sent === 1
        ? success({ success: false, errorReason: "settlement_pending" }, 402)
        : success();
    });
    await expect(agent.fetch(url)).rejects.toMatchObject({
      code: "payment_pending",
    });
    expect(agent.payments[0]).toMatchObject({
      transaction: hash,
      status: "pending",
      delivered: false,
    });
    await agent.retry(agent.payments[0].id);
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it("rejects a mismatched settlement and a success without a receipt", async () => {
    for (const result of [
      success({ network: "eip155:1" }),
      success({ payer: payTo }),
      success({ transaction: "" }),
      new Response("data"),
    ]) {
      const { agent } = setup(async (_value, init) =>
        new Headers(init?.headers).has("PAYMENT-SIGNATURE")
          ? result
          : challenge(),
      );
      await expect(agent.fetch(url)).rejects.toMatchObject({
        code: "payment_status_unknown",
      });
      expect(agent.payments[0].delivered).toBe(false);
    }
  });
  it("retains settled payment when resource delivery fails", async () => {
    let sent = 0;
    const { agent, sign } = setup(async (_value, init) =>
      !new Headers(init?.headers).has("PAYMENT-SIGNATURE")
        ? challenge()
        : success({}, ++sent === 1 ? 503 : 200),
    );
    await expect(agent.fetch(url)).rejects.toMatchObject({
      code: "payment_failed",
    });
    expect(agent.payments[0].status).toBe("settled");
    await agent.retry(agent.payments[0].id);
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it("does not refund the session budget after rejection or signer failure", async () => {
    const { agent } = setup(undefined, {
      signer: {
        address: account.address,
        signTypedData: async () => {
          throw new Error("signer unavailable");
        },
      },
    });
    await expect(agent.fetch(url)).rejects.toMatchObject({
      code: "invalid_payment",
    });
    expect(agent.reservedAmount).toBe(10000n);
  });
  it("snapshots policy and protects receipt logs from mutation", async () => {
    const { agent, options } = setup();
    options.allowedOrigins.push("https://evil.example");
    options.sessionBudget = 10000000n;
    await expect(agent.fetch("https://evil.example/")).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    await agent.fetch(url);
    agent.payments[0].amount = "0";
    expect(agent.payments[0].amount).toBe("10000");
  });
});
