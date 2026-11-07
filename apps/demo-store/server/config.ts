import { merchantIdFromSlug } from "@quietpay/shared";
import type { StoreConfig } from "./app.js";

type Env = Record<string, string | undefined>;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Turns the QUIETPAY_* environment variables into the store's settings. Throws an Error with a plain message when
 * something required is missing or malformed; server/index.ts prints it and exits.
 */
export function loadStoreConfig(env: Env = process.env): StoreConfig {
  // Secrets have no defaults: a publicly known fallback would let anyone forge webhooks or use the API key.
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`demo-store: missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
    return value;
  };
  const apiKey = required("QUIETPAY_API_KEY");
  const webhookSecret = required("QUIETPAY_WEBHOOK_SECRET");

  // The store's own payout address. Optional, but without it the store trusts the payout the relayer reports.
  const payout = env.QUIETPAY_PAYOUT_ADDRESS?.trim() || undefined;
  if (payout !== undefined && !ADDRESS.test(payout)) throw new Error("demo-store: QUIETPAY_PAYOUT_ADDRESS is not a valid 0x address.");
  if (payout === undefined) console.warn("demo-store: QUIETPAY_PAYOUT_ADDRESS is not set; the checkout pins the payout the relayer reports instead of your own.");

  const wallets = (env.QUIETPAY_MERCHANT_WALLETS ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  if (wallets.some((w) => !ADDRESS.test(w))) throw new Error("demo-store: QUIETPAY_MERCHANT_WALLETS must be comma separated 0x addresses.");
  if (wallets.length === 0 && payout) wallets.push(payout);

  const billingRaw = env.QUIETPAY_BILLING?.trim() || "both";
  const billing = billingRaw === "product" ? "one_time" : billingRaw; // "product" = one-time payments
  if (!["one_time", "subscription", "both"].includes(billing)) throw new Error("demo-store: QUIETPAY_BILLING must be product (one_time), subscription or both.");

  const chainId = Number(env.QUIETPAY_CHAIN_ID || 1874);
  return {
    baseUrl: env.QUIETPAY_BASE_URL || "http://localhost:8787",
    apiKey,
    merchantId: (env.QUIETPAY_MERCHANT_ID || merchantIdFromSlug("demo-store")) as `0x${string}`,
    payout: payout as `0x${string}` | undefined,
    webhookSecret,
    billing: billing as "one_time" | "subscription" | "both",
    subscriptionsFile: env.QUIETPAY_SUBSCRIPTIONS_FILE || undefined,
    paymentLinksFile: env.QUIETPAY_PAYMENT_LINKS_FILE || undefined,
    merchantName: env.QUIETPAY_MERCHANT_NAME || undefined,
    webhookUrl: env.QUIETPAY_WEBHOOK_URL || undefined,
    // Paid orders and processed webhook ids survive restarts here.
    stateFile: env.QUIETPAY_STATE_FILE || ".data/demo-store-state.json",
    receiptDatabasePath: env.QUIETPAY_RECEIPT_DATABASE_PATH || "quietpay-receipts.db",
    ledgerUrl: env.QUIETPAY_LEDGER_URL || undefined,
    merchantAuth: wallets.length
      ? { wallets, domain: env.QUIETPAY_AUTH_DOMAIN || "localhost:5173", uri: env.QUIETPAY_AUTH_URI || "http://localhost:5173", chainId }
      : undefined,
    refunds: env.QUIETPAY_DASHBOARD_TOKEN
      ? {
          dashboardToken: env.QUIETPAY_DASHBOARD_TOKEN,
          router: env.QUIETPAY_ROUTER_ADDRESS as `0x${string}`,
          chainId,
          tokenAddress: (env.QUIETPAY_TOKEN_ADDRESS || undefined) as `0x${string}` | undefined,
          tokenDomain: { name: env.TOKEN_DOMAIN_NAME || "Tether USD", version: env.TOKEN_DOMAIN_VERSION || "1" },
          refundSignerPrivateKey: env.QUIETPAY_REFUND_SIGNER_PRIVATE_KEY as `0x${string}`,
          databasePath: env.QUIETPAY_MERCHANT_DATABASE_PATH || "quietpay-merchant.db",
        }
      : undefined,
  };
}
