import * as sdk from "@quietpay/merchant-sdk"; // the real merchant SDK
import { buildApp } from "./app.js";
import { loadStoreConfig } from "./config.js"; // QUIETPAY_* environment variables -> store settings

let config;
try {
  config = loadStoreConfig();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

// HOST defaults to loopback (local dev). Hosting sets HOST=0.0.0.0 so the platform proxy can reach it.
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST || "127.0.0.1";
buildApp(sdk, config).listen({ port, host }).then(() => console.log(`demo-store api on http://${host}:${port}`));
