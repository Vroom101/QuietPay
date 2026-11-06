import { vi } from "vitest";
import { buildServer } from "@quietpay/relayer/core";
import { setup, payer, nonce } from "../../../packages/facilitator/test/helpers.js";
import { registerFacilitator } from "../../../packages/facilitator/src/server.js";
import { buildPaidApi } from "../src/app.js";
import { encodeX402Header, buildAgentAuthorization, type FacilitatorRequest } from "@quietpay/shared";

// W6 harness: fake-chain facilitator + paid API over real HTTP, with a signer that can forge arbitrary variants.
export async function running(over: Parameters<typeof setup>[0] = {}) {
  const e = setup(over);
  const facilitator = buildServer(e.svc);
  await registerFacilitator(facilitator, e.service);
  const facilitatorUrl = await facilitator.listen({ host: "127.0.0.1", port: 0 });
  const handler = vi.fn(() => ({ protected: "paid-data" }));
  const app = buildPaidApi({ policies: e.policies, facilitatorUrl, apiKey: "test-key", handlers: { "/v1/quote": handler } });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const policy = e.policies.find((p) => new URL(p.resource.url).pathname === "/v1/quote")!;
  /** Signs an authorization; every field can be forged independently of what the 402 asked for. */
  const forge = async (
    o: {
      n?: number;
      value?: bigint;
      to?: `0x${string}`;
      validBefore?: bigint;
      validAfter?: bigint;
      chainId?: number;
      token?: `0x${string}`;
      acceptedPatch?: Record<string, unknown>;
      resourceUrl?: string;
      signer?: typeof payer;
    } = {},
  ): Promise<FacilitatorRequest> => {
    const s = o.signer ?? payer;
    const a = {
      from: s.address,
      to: o.to ?? (policy.requirements.payTo as `0x${string}`),
      value: String(o.value ?? BigInt(policy.requirements.amount)),
      validAfter: String(o.validAfter ?? 0n),
      validBefore: String(o.validBefore ?? BigInt(e.clock.t + 55)),
      nonce: nonce(o.n ?? 1),
    };
    const signature = await s.signTypedData(
      buildAgentAuthorization({
        from: a.from,
        to: a.to,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
        chainId: o.chainId,
        token: o.token,
      }),
    );
    return {
      x402Version: 2,
      paymentRequirements: policy.requirements,
      paymentPayload: {
        x402Version: 2,
        resource: o.resourceUrl ? { ...policy.resource, url: o.resourceUrl } : policy.resource,
        accepted: { ...policy.requirements, ...(o.acceptedPatch ?? {}) } as never,
        payload: { authorization: a, signature },
      },
    };
  };
  const header = (r: FacilitatorRequest) => encodeX402Header(r.paymentPayload);
  const get = (r: FacilitatorRequest, path = "/v1/quote") => fetch(url + path, { headers: { "PAYMENT-SIGNATURE": header(r) } });
  const close = async () => {
    await app.close();
    await facilitator.close();
    e.service.stop();
    e.db.close();
  };
  return { ...e, facilitator, facilitatorUrl, handler, url, app, policy, forge, header, get, close };
}
