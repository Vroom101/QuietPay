import { merchantIdFromSlug } from "@quietpay/shared";
// Uses the real merchant SDK (the local stub in sdk-stub.ts is kept only for reference).
import * as sdk from "@quietpay/merchant-sdk";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const mockRelayer = process.env.QUIETPAY_MOCK_RELAYER === "1";
const app = buildApp(sdk, {
  baseUrl: process.env.QUIETPAY_BASE_URL || "http://localhost:8787",
  apiKey: process.env.QUIETPAY_API_KEY || "dev-api-key",
  merchantId: (process.env.QUIETPAY_MERCHANT_ID ||
    merchantIdFromSlug("demo-store")) as `0x${string}`,
  webhookSecret: process.env.QUIETPAY_WEBHOOK_SECRET || "dev-webhook-secret",
  webhookUrl: process.env.QUIETPAY_WEBHOOK_URL || undefined,
  receiptDatabasePath: process.env.QUIETPAY_RECEIPT_DATABASE_PATH || (mockRelayer ? ":memory:" : "quietpay-receipts.db"),
  mockRelayer,
  demoConversion: process.env.QUIETPAY_ENABLE_DEMO_CONVERSION === "1",
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

app
  .listen({ port, host: "127.0.0.1" })
  .then(() => console.log(`demo-store api on http://127.0.0.1:${port}`));
