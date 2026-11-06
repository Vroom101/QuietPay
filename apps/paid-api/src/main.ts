import { z } from "zod";
import { makePaidPolicies, token, Address, Bytes32 } from "@quietpay/shared";
import { buildPaidApi } from "./app.js";
const e = z
  .object({
    PAID_API_PUBLIC_URL: z.string().url(),
    FACILITATOR_URL: z.string().url(),
    QUIETPAY_API_KEY: z.string().min(1),
    FACILITATOR_MERCHANT_ID: Bytes32,
    FACILITATOR_PAYTO: Address,
    CHAIN_ID: z.coerce.number().int().positive().default(1874),
    USDT_ADDRESS: Address.default(token.address),
    PAID_API_PORT: z.coerce.number().int().min(0).max(65535).default(8790),
    X402_QUOTE_AMOUNT: z.string().default("10000"),
    X402_SIGNAL_AMOUNT: z.string().default("20000"),
  })
  .parse(process.env);
const policies = makePaidPolicies({
  baseUrl: e.PAID_API_PUBLIC_URL,
  merchantId: e.FACILITATOR_MERCHANT_ID,
  payTo: e.FACILITATOR_PAYTO,
  asset: e.USDT_ADDRESS,
  chainId: e.CHAIN_ID,
  name: token.eip712Domain.name,
  version: token.eip712Domain.version,
  quoteAmount: e.X402_QUOTE_AMOUNT,
  signalAmount: e.X402_SIGNAL_AMOUNT,
});
const app = buildPaidApi({
  policies,
  facilitatorUrl: e.FACILITATOR_URL,
  apiKey: e.QUIETPAY_API_KEY,
});
await app.listen({ host: "0.0.0.0", port: e.PAID_API_PORT });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
