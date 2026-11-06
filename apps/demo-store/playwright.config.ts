import { defineConfig } from "@playwright/test";

const storeUrl = "http://localhost:5173";
const relayerUrl = "http://localhost:8787";
const storeApiUrl = "http://127.0.0.1:3001";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: storeUrl, trace: "retain-on-failure" },
  webServer: [
    {
      command: "tsx ../../packages/shared/src/mock-server.ts",
      url: `${relayerUrl}/v1/health`,
      env: { PORT: "8787" },
    },
    {
      command: "tsx server/index.ts",
      url: `${storeApiUrl}/api/orders/ready/paid`,
      env: {
        PORT: "3001",
        QUIETPAY_BASE_URL: relayerUrl,
        QUIETPAY_API_KEY: "dev-api-key",
        QUIETPAY_MERCHANT_ID: "",
        QUIETPAY_WEBHOOK_SECRET: "dev-webhook-secret",
        QUIETPAY_WEBHOOK_URL: "",
        QUIETPAY_MOCK_RELAYER: "1",
        QUIETPAY_ENABLE_DEMO_CONVERSION: "1",
      },
    },
    {
      command: "vite --strictPort",
      url: storeUrl,
      env: {
        VITE_RELAYER_URL: relayerUrl,
        VITE_CHECKOUT_ROUTER: "0x1111111111111111111111111111111111111111",
        VITE_CHECKOUT_TOKEN: "",
        VITE_CHECKOUT_DOMAIN_NAME: "",
        VITE_CHECKOUT_DOMAIN_VERSION: "",
      },
    },
  ],
});
