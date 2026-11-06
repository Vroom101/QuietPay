import { z } from "zod";
import { ScopeSchema, type Scope } from "./model.js";
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const e = z
    .object({
      RPC_URL: z.string().url(),
      CHAIN_ID: z.coerce.number().int().positive().default(1874),
      ROUTER_ADDRESS: ScopeSchema.shape.router,
      USDT_ADDRESS: ScopeSchema.shape.token,
      INDEXER_FROM_BLOCK: z.preprocess(
        (value) => (value === "" ? undefined : value),
        z.coerce.number().int().nonnegative().safe(),
      ),
      INDEXER_CONFIRMATIONS: z.coerce
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(2),
      INDEXER_DATABASE_PATH: z.string().default("./quietpay-indexer.db"),
      INDEXER_POLL_MS: z.coerce.number().int().min(100).default(5000),
      INDEXER_PORT: z.coerce.number().int().min(0).max(65535).default(8788),
      MERCHANT_API_KEYS: z.string().optional(),
      FACILITATOR_PAYTO: ScopeSchema.shape.router.optional(),
      FACILITATOR_MERCHANT_ID: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/)
        .optional(),
    })
    .parse(env);
  if (Boolean(e.FACILITATOR_PAYTO) !== Boolean(e.FACILITATOR_MERCHANT_ID))
    throw new Error(
      "Set both FACILITATOR_PAYTO and FACILITATOR_MERCHANT_ID, or neither",
    );
  const scope: Scope = {
    chainId: e.CHAIN_ID,
    router: e.ROUTER_ADDRESS,
    token: e.USDT_ADDRESS,
    deploymentBlock: e.INDEXER_FROM_BLOCK,
    confirmations: e.INDEXER_CONFIRMATIONS,
    ...(e.FACILITATOR_PAYTO
      ? {
          agent: {
            payTo: e.FACILITATOR_PAYTO,
            merchantId: e.FACILITATOR_MERCHANT_ID!,
          },
        }
      : {}),
  };
  const apiKeys = new Map<string, string>();
  for (const pair of (e.MERCHANT_API_KEYS ?? "").split(",").filter(Boolean)) {
    const [key, merchant, ...rest] = pair.trim().split(":");
    if (
      !key ||
      !merchant ||
      rest.length ||
      !/^0x[0-9a-fA-F]{64}$/.test(merchant)
    )
      throw new Error("Invalid MERCHANT_API_KEYS entry");
    apiKeys.set(key, merchant.toLowerCase());
  }
  return {
    scope,
    rpcUrl: e.RPC_URL,
    databasePath: e.INDEXER_DATABASE_PATH,
    pollMs: e.INDEXER_POLL_MS,
    port: e.INDEXER_PORT,
    apiKeys,
  };
}
