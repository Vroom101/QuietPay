import { z } from "zod";
import { parseUnits } from "viem";

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
  WEBHOOK_SECRET: z.string().min(16),
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
  // Optional, additive to the frozen list.
  RELAY_FEE_USDT: decimal(6).default("0.05"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  EXPLORER_BASE_URL: z.string().url().default("https://testnet.whitechain.io"),
  TOKEN_DOMAIN_NAME: z.string().trim().min(1).default("Tether USD"),
  TOKEN_DOMAIN_VERSION: z.string().trim().min(1).default("1"),
  PORT: z.coerce.number().int().default(8787),
});

export interface Config {
  rpcUrl: string;
  chainId: number;
  usdt: `0x${string}`;
  router: `0x${string}`;
  relayerKey: `0x${string}`;
  operatorToken: string;
  apiKeys: Map<string, `0x${string}`>; // apiKey -> merchantId
  webhookSecret: string;
  databasePath: string;
  lossBudgetWei: bigint;
  maxGasPrice: bigint | null;
  maxGasLimit: bigint;
  lowBalanceWei: bigint;
  pendingRetrySeconds: number;
  maxReplacements: number;
  payerCap: bigint; // USDT base units
  relayFee: bigint; // USDT base units
  rateLimitPerMinute: number;
  explorerBaseUrl: string;
  tokenDomain: { name: string; version: string };
  port: number;
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
    databasePath: e.DATABASE_PATH,
    lossBudgetWei: parseUnits(e.LOSS_BUDGET_WBT_PER_HOUR, 18),
    maxGasPrice: e.MAX_GAS_PRICE ? BigInt(e.MAX_GAS_PRICE) : null,
    maxGasLimit: e.MAX_GAS_LIMIT,
    lowBalanceWei: parseUnits(e.LOW_BALANCE_WBT, 18),
    pendingRetrySeconds: e.PENDING_RETRY_SECONDS,
    maxReplacements: e.MAX_REPLACEMENTS,
    payerCap: parseUnits(e.PAYER_CAP_USDT, 6),
    relayFee: parseUnits(e.RELAY_FEE_USDT, 6),
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    explorerBaseUrl: e.EXPLORER_BASE_URL.replace(/\/$/, ""),
    tokenDomain: { name: e.TOKEN_DOMAIN_NAME, version: e.TOKEN_DOMAIN_VERSION },
    port: e.PORT,
  };
}
