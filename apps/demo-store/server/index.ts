import { merchantIdFromSlug } from "@quietpay/shared";
// Uses the real merchant SDK (the local stub in sdk-stub.ts is kept only for reference).
import * as sdk from "@quietpay/merchant-sdk";
import { buildApp } from "./app.js";

/** Secrets have no defaults: a publicly known fallback would let anyone forge webhooks or use the API key. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`demo-store: missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const apiKey = requireEnv("QUIETPAY_API_KEY");
const webhookSecret = requireEnv("QUIETPAY_WEBHOOK_SECRET");

/** The store's own payout address. Optional, but without it the store trusts the payout the relayer reports. */
const payoutEnv = process.env.QUIETPAY_PAYOUT_ADDRESS?.trim() || undefined;
if (payoutEnv !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(payoutEnv)) {
  console.error("demo-store: QUIETPAY_PAYOUT_ADDRESS is not a valid 0x address.");
  process.exit(1);
}
if (payoutEnv === undefined) {
  console.warn("demo-store: QUIETPAY_PAYOUT_ADDRESS is not set; the checkout pins the payout the relayer reports instead of your own.");
}

const merchantWallets = (process.env.QUIETPAY_MERCHANT_WALLETS ?? "")
  .split(",").map((w) => w.trim()).filter(Boolean);
if (merchantWallets.some((w) => !/^0x[0-9a-fA-F]{40}$/.test(w))) {
  console.error("demo-store: QUIETPAY_MERCHANT_WALLETS must be comma separated 0x addresses.");
  process.exit(1);
}
if (merchantWallets.length === 0 && payoutEnv) merchantWallets.push(payoutEnv);

const port = Number(process.env.PORT ?? 3001);
const app = buildApp(sdk, {
  baseUrl: process.env.QUIETPAY_BASE_URL || "http://localhost:8787",
  apiKey,
  merchantId: (process.env.QUIETPAY_MERCHANT_ID || merchantIdFromSlug("demo-store")) as `0x${string}`,
  payout: payoutEnv as `0x${string}` | undefined,
  webhookSecret,
  webhookUrl: process.env.QUIETPAY_WEBHOOK_URL || undefined,
  // Paid orders and processed webhook ids survive restarts here.
  stateFile: process.env.QUIETPAY_STATE_FILE || ".data/demo-store-state.json",
  receiptDatabasePath: process.env.QUIETPAY_RECEIPT_DATABASE_PATH || "quietpay-receipts.db",
  merchantAuth: merchantWallets.length
    ? {
        wallets: merchantWallets,
        domain: process.env.QUIETPAY_AUTH_DOMAIN || "localhost:5173",
        uri: process.env.QUIETPAY_AUTH_URI || "http://localhost:5173",
        chainId: Number(process.env.QUIETPAY_CHAIN_ID || 1874),
      }
    : undefined,
  refunds: process.env.QUIETPAY_DASHBOARD_TOKEN
    ? {
        dashboardToken: process.env.QUIETPAY_DASHBOARD_TOKEN,
        router: process.env.QUIETPAY_ROUTER_ADDRESS as `0x${string}`,
        chainId: Number(process.env.QUIETPAY_CHAIN_ID || 1874),
        tokenAddress: (process.env.QUIETPAY_TOKEN_ADDRESS || undefined) as `0x${string}` | undefined,
        tokenDomain: { name: process.env.TOKEN_DOMAIN_NAME || "Tether USD", version: process.env.TOKEN_DOMAIN_VERSION || "1" },
        refundSignerPrivateKey: process.env
          .QUIETPAY_REFUND_SIGNER_PRIVATE_KEY as `0x${string}`,
        databasePath:
          process.env.QUIETPAY_MERCHANT_DATABASE_PATH || "quietpay-merchant.db",
      }
    : undefined,
});

// HOST defaults to loopback (local dev). Hosting sets HOST=0.0.0.0 so the platform proxy can reach it.
const host = process.env.HOST || "127.0.0.1";
app.listen({ port, host }).then(() => console.log(`demo-store api on http://${host}:${port}`));
