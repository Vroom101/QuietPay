import { merchantIdFromSlug } from "@quietpay/shared";
// Uses the real merchant SDK (the local stub in sdk-stub.ts is kept only for reference).
import * as sdk from "@quietpay/merchant-sdk";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const baseUrl = process.env.QUIETPAY_BASE_URL || "http://localhost:8787";
const app = buildApp(sdk, {
  baseUrl,
  apiKey: process.env.QUIETPAY_API_KEY || "dev-api-key",
  merchantId: (process.env.QUIETPAY_MERCHANT_ID || merchantIdFromSlug("demo-store")) as `0x${string}`,
  webhookSecret: process.env.QUIETPAY_WEBHOOK_SECRET || "dev-webhook-secret",
  webhookUrl: process.env.QUIETPAY_WEBHOOK_URL || undefined,
  demoConversion: process.env.QUIETPAY_ENABLE_DEMO_CONVERSION === "1" && baseUrl === "http://localhost:8787",
});

app.listen({ port, host: "127.0.0.1" }).then(() => console.log(`demo-store api on http://127.0.0.1:${port}`));
