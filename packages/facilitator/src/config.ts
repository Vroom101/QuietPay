import { z } from "zod";
import { loadConfig as loadRelayerConfig } from "@quietpay/relayer/core";
import { makePaidPolicies, Address, Bytes32 } from "@quietpay/shared";
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const relay = loadRelayerConfig(env);
  const e = z
    .object({
      PAID_API_PUBLIC_URL: z.string().url(),
      FACILITATOR_PAYTO: Address,
      FACILITATOR_MERCHANT_ID: Bytes32,
      X402_SETTLEMENT_WAIT_MS: z.coerce
        .number()
        .int()
        .min(0)
        .max(60000)
        .default(5000),
      X402_QUOTE_AMOUNT: z.string().default("10000"),
      X402_SIGNAL_AMOUNT: z.string().default("20000"),
    })
    .parse(env);
  return {
    relay,
    settlementWaitMs: e.X402_SETTLEMENT_WAIT_MS,
    policies: makePaidPolicies({
      baseUrl: e.PAID_API_PUBLIC_URL,
      merchantId: e.FACILITATOR_MERCHANT_ID,
      payTo: e.FACILITATOR_PAYTO,
      asset: relay.usdt,
      chainId: relay.chainId,
      name: relay.tokenDomain.name,
      version: relay.tokenDomain.version,
      quoteAmount: e.X402_QUOTE_AMOUNT,
      signalAmount: e.X402_SIGNAL_AMOUNT,
    }),
  };
}
