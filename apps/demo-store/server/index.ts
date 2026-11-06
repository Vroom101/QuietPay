import { merchantIdFromSlug } from "@quietpay/shared";
// To use the real SDK, replace this one line with: import * as sdk from "@quietpay/merchant-sdk";
import * as sdk from "./sdk-stub.js";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const app = buildApp(sdk, {
  baseUrl: process.env.QUIETPAY_BASE_URL || "http://localhost:8787",
  apiKey: process.env.QUIETPAY_API_KEY || "dev-api-key",
  merchantId: (process.env.QUIETPAY_MERCHANT_ID || merchantIdFromSlug("demo-store")) as `0x${string}`,
  webhookSecret: process.env.QUIETPAY_WEBHOOK_SECRET || "dev-webhook-secret",
  webhookUrl: process.env.QUIETPAY_WEBHOOK_URL || undefined,
});

app.listen({ port, host: "127.0.0.1" }).then(() => console.log(`demo-store api on http://127.0.0.1:${port}`));
