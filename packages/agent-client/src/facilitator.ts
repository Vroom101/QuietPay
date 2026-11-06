import { getAddress, isHex, type Address, type Hex } from "viem";
import type { FacilitatorLookup, FacilitatorStatus } from "./store.js";

/**
 * HTTP client for the facilitator's read-only GET /v1/x402/payments/:payer/:nonce
 * (status only). The answer is advisory: recovery never releases budget on it.
 */
export function httpFacilitatorLookup(
  baseUrl: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): FacilitatorLookup {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash)
    throw new Error("Facilitator URL must not carry credentials, query or fragment");
  const doFetch = opts.fetch ?? fetch;
  return {
    async status({ payer, nonce }: { payer: Address; nonce: Hex }) {
      if (!isHex(nonce, { strict: true }) || nonce.length !== 66)
        throw new Error("Invalid nonce");
      const u = new URL(
        `/v1/x402/payments/${getAddress(payer)}/${nonce}`,
        base,
      );
      const res = await doFetch(u.href, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
      });
      if (res.status === 404) return { status: "unknown" as FacilitatorStatus };
      if (!res.ok) throw new Error(`Facilitator HTTP ${res.status}`);
      const body = (await res.json()) as { status?: unknown; transaction?: unknown };
      if (
        typeof body?.status !== "string" ||
        !["settled", "pending", "failed", "unknown"].includes(body.status)
      )
        throw new Error("Unrecognised facilitator status");
      const transaction =
        typeof body.transaction === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(body.transaction)
          ? (body.transaction as Hex)
          : undefined;
      return { status: body.status as FacilitatorStatus, transaction };
    },
  };
}
