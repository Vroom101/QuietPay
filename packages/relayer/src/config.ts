import { z } from "zod";
import { parseUnits } from "viem";

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const EnvSchema = z.object({
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().default(1874),
  USDT_ADDRESS: hexAddress,
  ROUTER_ADDRESS: hexAddress,
  RELAYER_PRIVATE_KEY: hexKey,
  OPERATOR_TOKEN: z.string().min(16, "OPERATOR_TOKEN must be at least 16 characters"),
  /** `apiKey:merchantId` pairs, comma separated. merchantId is a 0x bytes32. */
  MERCHANT_API_KEYS: z.string().min(1),
  /**
   * Master webhook key. Never given to merchants: each merchant's webhooks are signed with
   * HMAC-SHA256(WEBHOOK_SECRET, merchantId.toLowerCase()) as lowercase hex (see merchantWebhookSecret
   * in webhooks.ts), and the operator hands each merchant only its own derived secret:
   *   printf %s 0x<merchantId lowercase> | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET"
   */
  WEBHOOK_SECRET: z.string().min(16),
  /**
   * "1" lets merchants register loopback / private-range webhook URLs (127.0.0.1, 10/8, 192.168/16, ...).
   * Local development and tests only. Link-local, cloud metadata and 0.0.0.0 stay refused regardless.
   */
  ALLOW_PRIVATE_WEBHOOKS: z.enum(["0", "1", "true", "false", ""]).default("0"),
  DATABASE_PATH: z.string().default("./quietpay.db"),
  /** Decimal WBT. Hard cap on gas spent per rolling hour. */
  LOSS_BUDGET_WBT_PER_HOUR: z.string().default("0.05"),
  /** Wei. Empty means no cap. */
  MAX_GAS_PRICE: z.string().optional(),
  /** Decimal USDT. Cumulative per-payer cap over a rolling 24h. */
  PAYER_CAP_USDT: z.string().default("100"),
  // Optional, additive to the frozen list.
  RELAY_FEE_USDT: z.string().default("0.05"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** EIP-712 domain of the payment token. Defaults to the live Whitechain test USDT. Set for the demo token. */
  TOKEN_DOMAIN_NAME: z.string().default("Tether USD"),
  TOKEN_DOMAIN_VERSION: z.string().default("1"),
  EXPLORER_BASE_URL: z.string().url().default("https://testnet.whitechain.io"),
  PORT: z.coerce.number().int().default(8787),
  /**
   * Seconds that must remain before the payer's validBefore when the relayer broadcasts. A window that
   * ends sooner can expire before inclusion and revert at the relayer's cost.
   */
  MIN_VALID_SECONDS: z.coerce.number().int().nonnegative().default(60),
  /** A payer who caused an on-chain revert in the last 24h must leave at least this many seconds. */
  REVERTED_PAYER_MIN_VALID_SECONDS: z.coerce.number().int().nonnegative().default(120),
  /** Refuse a payer, and separately an order, after this many on-chain reverts in a rolling 24h. */
  MAX_REVERTS_PER_DAY: z.coerce.number().int().positive().default(2),
  /** Percent of LOSS_BUDGET_WBT_PER_HOUR one payer's reverted transactions may consume in a rolling hour. */
  PAYER_LOSS_SHARE_PERCENT: z.coerce.number().int().min(1).max(100).default(25),
  /** A broadcast tx with no receipt after this long is rebroadcast once from its persisted bytes, then failed. */
  TX_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(1800),
  /** How often the reconciliation loop re-checks every broadcast, unresolved transaction. */
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
});

export interface Config {
  rpcUrl: string;
  chainId: number;
  usdt: `0x${string}`;
  router: `0x${string}`;
  relayerKey: `0x${string}`;
  operatorToken: string;
  apiKeys: Map<string, `0x${string}`>; // apiKey -> merchantId
  webhookSecret: string; // master key; merchants get merchantWebhookSecret(webhookSecret, merchantId)
  allowPrivateWebhooks: boolean;
  databasePath: string;
  lossBudgetWei: bigint;
  maxGasPrice: bigint | null;
  payerCap: bigint; // USDT base units
  relayFee: bigint; // USDT base units
  rateLimitPerMinute: number;
  tokenDomain: { name: string; version: string };
  explorerBaseUrl: string;
  port: number;
  minValidSeconds: number;
  revertedPayerMinValidSeconds: number;
  maxRevertsPerDay: number;
  payerLossSharePercent: number;
  txMaxAgeSeconds: number;
  reconcileIntervalSeconds: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  const apiKeys = new Map<string, `0x${string}`>();
  for (const pair of e.MERCHANT_API_KEYS.split(",")) {
    const [k, m] = pair.trim().split(":");
    if (!k || !m || !/^0x[0-9a-fA-F]{64}$/.test(m)) {
      throw new Error("MERCHANT_API_KEYS must be `apiKey:0x<bytes32 merchantId>` pairs");
    }
    apiKeys.set(k, m as `0x${string}`);
  }
  return {
    rpcUrl: e.RPC_URL,
    chainId: e.CHAIN_ID,
    usdt: e.USDT_ADDRESS as `0x${string}`,
    router: e.ROUTER_ADDRESS as `0x${string}`,
    relayerKey: e.RELAYER_PRIVATE_KEY as `0x${string}`,
    operatorToken: e.OPERATOR_TOKEN,
    apiKeys,
    webhookSecret: e.WEBHOOK_SECRET,
    allowPrivateWebhooks: e.ALLOW_PRIVATE_WEBHOOKS === "1" || e.ALLOW_PRIVATE_WEBHOOKS === "true",
    databasePath: e.DATABASE_PATH,
    lossBudgetWei: parseUnits(e.LOSS_BUDGET_WBT_PER_HOUR, 18),
    maxGasPrice: e.MAX_GAS_PRICE ? BigInt(e.MAX_GAS_PRICE) : null,
    payerCap: parseUnits(e.PAYER_CAP_USDT, 6),
    relayFee: parseUnits(e.RELAY_FEE_USDT, 6),
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    tokenDomain: { name: e.TOKEN_DOMAIN_NAME, version: e.TOKEN_DOMAIN_VERSION },
    explorerBaseUrl: e.EXPLORER_BASE_URL.replace(/\/$/, ""),
    port: e.PORT,
    minValidSeconds: e.MIN_VALID_SECONDS,
    revertedPayerMinValidSeconds: e.REVERTED_PAYER_MIN_VALID_SECONDS,
    maxRevertsPerDay: e.MAX_REVERTS_PER_DAY,
    payerLossSharePercent: e.PAYER_LOSS_SHARE_PERCENT,
    txMaxAgeSeconds: e.TX_MAX_AGE_SECONDS,
    reconcileIntervalSeconds: e.RECONCILE_INTERVAL_SECONDS,
  };
}
