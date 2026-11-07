import { z } from "zod";
import { parseUnits } from "viem";
import { assertQualifyingConfig, getQualifyingDeployment } from "@quietpay/shared";

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const decimal = (places: number) => z.string().regex(new RegExp(`^[0-9]+(?:\\.[0-9]{1,${places}})?$`), "Invalid non-negative decimal amount");

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
  LOSS_BUDGET_WBT_PER_HOUR: decimal(18).default("0.05"),
  /** Wei. Empty means no cap. */
  MAX_GAS_PRICE: z.string().regex(/^(?:[1-9][0-9]*)?$/).optional(),
  /** Decimal USDT. Cumulative per-payer cap over a rolling 24h. */
  PAYER_CAP_USDT: decimal(6).default("100"),
  MAX_GAS_LIMIT: z.coerce.bigint().positive().default(500000n),
  LOW_BALANCE_WBT: decimal(18).default("0.01"),
  PENDING_RETRY_SECONDS: z.coerce.number().int().min(5).default(30),
  MAX_REPLACEMENTS: z.coerce.number().int().min(0).max(10).default(3),
  /** Blocks a success receipt must be buried under before an order settles (reorg protection). 1 = first receipt. */
  CORS_ORIGINS: z.string().default(""),
  SETTLE_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(1),
  // Optional, additive to the frozen list.
  RELAY_FEE_USDT: decimal(6).default("0.05"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  ORDERS_PER_MINUTE_PER_MERCHANT: z.coerce.number().int().positive().max(1_000_000).default(1200),
  /** EIP-712 domain of the payment token. Defaults to the live Whitechain test USDT. */
  EXPLORER_BASE_URL: z.string().url().default("https://testnet.whitechain.io"),
  TOKEN_DOMAIN_NAME: z.string().trim().min(1).default("Tether USD"),
  TOKEN_DOMAIN_VERSION: z.string().trim().min(1).default("1"),
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
  /**
   * Fallback age limit for a broadcast tx with no receipt (rebroadcast once while its authorization is still
   * valid, then failed). Normally a tx is resolved at its authorization's validBefore first. Must be at least
   * MIN_TX_MAX_AGE_SECONDS (600, the longest authorization window): a shorter value can fail an order whose
   * tx is still valid and may still land.
   */
  TX_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(1800),
  /**
   * Percent of LOSS_BUDGET_WBT_PER_HOUR that reverts by first-time payers (no prior successful settlement)
   * may consume of the budget shared with everyone else. Losses above it never pause other payers.
   */
  FIRST_TIME_PAYER_LOSS_SHARE_PERCENT: z.coerce.number().int().min(0).max(100).default(5),
  /**
   * Hard ceiling, in percent of LOSS_BUDGET_WBT_PER_HOUR, on gas lost to reverts by first-time payers in a
   * rolling hour. Once reached, first-time payers are refused (repeat payers are unaffected) until it frees up.
   */
  FIRST_TIME_PAYER_LOSS_CAP_PERCENT: z.coerce.number().int().min(0).max(1000).default(100),
  /** Distinct first-time payer addresses one client IP may relay for in a rolling hour. */
  MAX_NEW_PAYERS_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(10),
  /**
   * Number of trusted reverse proxies in front of the relayer (Render adds 1). 0 (default) ignores
   * X-Forwarded-For entirely and keys limits by the socket address. N > 0 takes the Nth entry from the right.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
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
  maxGasLimit: bigint;
  lowBalanceWei: bigint;
  pendingRetrySeconds: number;
  maxReplacements: number;
  settleConfirmations: number;
  /** Browser origins allowed to call authenticated routes (CORS_ORIGINS, comma separated). Empty = none. */
  corsOrigins: string[];
  payerCap: bigint; // USDT base units
  relayFee: bigint; // USDT base units
  rateLimitPerMinute: number;
  /** Per-merchant (valid API key) cap for the orders routes, per minute. Default 1200. */
  ordersPerMinutePerMerchant?: number;
  tokenDomain: { name: string; version: string };
  explorerBaseUrl: string;
  port: number;
  minValidSeconds: number;
  revertedPayerMinValidSeconds: number;
  maxRevertsPerDay: number;
  payerLossSharePercent: number;
  txMaxAgeSeconds: number;
  reconcileIntervalSeconds: number;
  firstTimePayerLossSharePercent: number;
  firstTimePayerLossCapPercent: number;
  maxNewPayersPerIpPerHour: number;
  trustProxyHops: number;
}

/** Lower bound for TX_MAX_AGE_SECONDS: the longest authorization window (10 min). */
export const MIN_TX_MAX_AGE_SECONDS = 600;

/** Minimum length of a merchant API key (OPERATOR_TOKEN needs 16; these are online-guessable, so longer). */
export const MIN_API_KEY_LENGTH = 24;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  // Qualifying guard, no bypass: chain 1874, the official USDT, and the recorded qualifying router only.
  assertQualifyingConfig({ chainId: e.CHAIN_ID, tokenAddress: e.USDT_ADDRESS });
  const qualifyingRouter = getQualifyingDeployment().router;
  if (e.ROUTER_ADDRESS.toLowerCase() !== qualifyingRouter.toLowerCase()) {
    throw new Error(`Wrong router: expected the qualifying router ${qualifyingRouter}, got ${e.ROUTER_ADDRESS}`);
  }
  if (e.TX_MAX_AGE_SECONDS < MIN_TX_MAX_AGE_SECONDS) {
    throw new Error(
      `TX_MAX_AGE_SECONDS must be at least ${MIN_TX_MAX_AGE_SECONDS} (got ${e.TX_MAX_AGE_SECONDS}): a shorter value fails orders whose tx is still valid and may still be mined.`,
    );
  }
  const apiKeys = new Map<string, `0x${string}`>();
  for (const pair of e.MERCHANT_API_KEYS.split(",")) {
    const [k, m] = pair.trim().split(":");
    if (!k || !m || !/^0x[0-9a-fA-F]{64}$/.test(m)) {
      throw new Error("MERCHANT_API_KEYS must be `apiKey:0x<bytes32 merchantId>` pairs");
    }
    if (k.length < MIN_API_KEY_LENGTH) {
      throw new Error(`MERCHANT_API_KEYS: every API key must be at least ${MIN_API_KEY_LENGTH} characters`);
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
    maxGasLimit: e.MAX_GAS_LIMIT,
    lowBalanceWei: parseUnits(e.LOW_BALANCE_WBT, 18),
    pendingRetrySeconds: e.PENDING_RETRY_SECONDS,
    maxReplacements: e.MAX_REPLACEMENTS,
    settleConfirmations: e.SETTLE_CONFIRMATIONS,
    corsOrigins: e.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
    payerCap: parseUnits(e.PAYER_CAP_USDT, 6),
    relayFee: parseUnits(e.RELAY_FEE_USDT, 6),
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    ordersPerMinutePerMerchant: e.ORDERS_PER_MINUTE_PER_MERCHANT,
    tokenDomain: { name: e.TOKEN_DOMAIN_NAME, version: e.TOKEN_DOMAIN_VERSION },
    explorerBaseUrl: e.EXPLORER_BASE_URL.replace(/\/$/, ""),
    port: e.PORT,
    minValidSeconds: e.MIN_VALID_SECONDS,
    revertedPayerMinValidSeconds: e.REVERTED_PAYER_MIN_VALID_SECONDS,
    maxRevertsPerDay: e.MAX_REVERTS_PER_DAY,
    payerLossSharePercent: e.PAYER_LOSS_SHARE_PERCENT,
    txMaxAgeSeconds: e.TX_MAX_AGE_SECONDS,
    reconcileIntervalSeconds: e.RECONCILE_INTERVAL_SECONDS,
    firstTimePayerLossSharePercent: e.FIRST_TIME_PAYER_LOSS_SHARE_PERCENT,
    firstTimePayerLossCapPercent: e.FIRST_TIME_PAYER_LOSS_CAP_PERCENT,
    maxNewPayersPerIpPerHour: e.MAX_NEW_PAYERS_PER_IP_PER_HOUR,
    trustProxyHops: e.TRUST_PROXY_HOPS,
  };
}
