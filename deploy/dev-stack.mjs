// Starts the whole demo on this machine against the REAL Whitechain testnet (chain 1874, official USDT, qualifying router):
//   relayer (http://127.0.0.1:8790)  +  ledger (8788)  +  demo store server (http://127.0.0.1:3001)  +  web UI (http://localhost:5173)
//
//   node --env-file=<path to your gitignored env file> deploy/dev-stack.mjs
//
// The env file supplies RPC_URL, RELAYER_PRIVATE_KEY, OPERATOR_TOKEN, WEBHOOK_SECRET, MERCHANT_API_KEY,
// MERCHANT_PAYOUT_ADDRESS, REFUND_SIGNER_PRIVATE_KEY, ROUTER_ADDRESS, USDT_ADDRESS. Nothing from it is ever printed.
// Only processes started here are stopped (by PID) on Ctrl+C. State goes to a fresh temp folder.
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing ${k} in the env file`);
    process.exit(1);
  }
  return v;
};

// The qualifying deployment is the only one this demo will talk to.
const dep = (await import("node:fs")).readFileSync(resolve(root, "contracts/deployments.json"), "utf8");
const qualifying = JSON.parse(dep)["1874"];
if (qualifying?.qualifying !== true) throw new Error("contracts/deployments.json has no qualifying entry for chain 1874");
const router = qualifying.router;
const usdt = qualifying.token;
const merchantId = Object.values(qualifying.merchants)[0].merchantId;
if (process.env.ROUTER_ADDRESS && process.env.ROUTER_ADDRESS.toLowerCase() !== router.toLowerCase()) throw new Error("ROUTER_ADDRESS in the env file is not the qualifying router");

const RELAYER_PORT = Number(process.env.DEV_RELAYER_PORT ?? 8790); // 8787 is often taken by the mock relayer
const LEDGER_PORT = Number(process.env.DEV_LEDGER_PORT ?? 8788);
const PAID_API_PORT = Number(process.env.DEV_PAID_API_PORT ?? 8791);
const paidApiUrl = `http://127.0.0.1:${PAID_API_PORT}`;
const payTo = need("MERCHANT_PAYOUT_ADDRESS"); // x402 agent payments go straight to the merchant payout
const master = need("WEBHOOK_SECRET");
const merchantApiKey = need("MERCHANT_API_KEY");
const storeWebhookSecret = createHmac("sha256", master).update(merchantId.toLowerCase()).digest("hex"); // per-merchant secret
const dashboardToken = randomBytes(24).toString("hex");
const tmp = mkdtempSync(resolve(tmpdir(), "quietpay-demo-"));
mkdirSync(resolve(tmp, "logs"), { recursive: true });
// Orders, refunds and receipts survive a restart (so the dashboard, gas totals and ledger keep their history).
// Pass --fresh to start from an empty state for this run only.
const state = process.argv.includes("--fresh") ? tmp : resolve(tmpdir(), "quietpay-demo-state-1874");
mkdirSync(state, { recursive: true });

const base = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: process.env.USERPROFILE ?? "", TEMP: process.env.TEMP ?? "" };
const children = [];
function start(name, cwd, args, env) {
  const log = createWriteStream(resolve(tmp, "logs", `${name}.log`), { flags: "a" });
  const child = spawn(process.execPath, args, { cwd: resolve(root, cwd), env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on("exit", (code) => console.log(`${name} exited (${code})`));
  children.push(child);
  return child;
}

// The combined relayer + x402 facilitator: every relayer route (checkout, refunds) plus /v1/x402/* for agent payments.
start("relayer", "packages/facilitator", ["--import", "tsx", "src/main.ts"], {
  PAID_API_PUBLIC_URL: paidApiUrl, FACILITATOR_PAYTO: payTo, FACILITATOR_MERCHANT_ID: merchantId,
  RPC_URL: need("RPC_URL"), CHAIN_ID: "1874", USDT_ADDRESS: usdt, ROUTER_ADDRESS: router, RELAYER_PRIVATE_KEY: need("RELAYER_PRIVATE_KEY"),
  OPERATOR_TOKEN: need("OPERATOR_TOKEN"), MERCHANT_API_KEYS: `${merchantApiKey}:${merchantId}`, WEBHOOK_SECRET: master,
  ALLOW_PRIVATE_WEBHOOKS: "1", // the store's webhook endpoint is on localhost in this demo
  CORS_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173", DATABASE_PATH: resolve(state, "relayer.db"), PORT: String(RELAYER_PORT),
  LOSS_BUDGET_WBT_PER_HOUR: "0.2", RELAY_FEE_USDT: "0.05", EXPLORER_BASE_URL: "https://explorer.testnet.whitechain.io",
  RATE_LIMIT_PER_MINUTE: "60", MAX_NEW_PAYERS_PER_IP_PER_HOUR: "50",
});

// On-chain ledger (packages/indexer): reads every PaymentRouter event from the chain. Its database lives outside the
// per-run temp folder so a restart resumes from where it stopped instead of re-reading the chain from the deploy block.
start("ledger", "packages/indexer", ["--import", "tsx", "src/api/main.ts"], {
  RPC_URL: need("RPC_URL"), CHAIN_ID: "1874", ROUTER_ADDRESS: router, USDT_ADDRESS: usdt, INDEXER_FROM_BLOCK: String(qualifying.deployBlock),
  INDEXER_DATABASE_PATH: resolve(tmpdir(), "quietpay-ledger-1874-agent.db"), FACILITATOR_PAYTO: payTo, FACILITATOR_MERCHANT_ID: merchantId, INDEXER_PORT: String(LEDGER_PORT), INDEXER_HOST: "127.0.0.1",
  MERCHANT_API_KEYS: `${merchantApiKey}:${merchantId}`,
});

start("store", "apps/demo-store", ["--import", "tsx", "server/index.ts"], {
  PORT: "3001", HOST: "127.0.0.1", QUIETPAY_BASE_URL: `http://127.0.0.1:${RELAYER_PORT}`, QUIETPAY_API_KEY: merchantApiKey,
  QUIETPAY_WEBHOOK_SECRET: storeWebhookSecret, QUIETPAY_MERCHANT_ID: merchantId, QUIETPAY_PAYOUT_ADDRESS: need("MERCHANT_PAYOUT_ADDRESS"),
  QUIETPAY_WEBHOOK_URL: "http://127.0.0.1:3001/webhooks/quietpay",
  QUIETPAY_STATE_FILE: resolve(state, "store-state.json"), QUIETPAY_RECEIPT_DATABASE_PATH: resolve(state, "store-receipts.db"),
  QUIETPAY_DASHBOARD_TOKEN: dashboardToken, QUIETPAY_ROUTER_ADDRESS: router, QUIETPAY_CHAIN_ID: "1874", QUIETPAY_TOKEN_ADDRESS: usdt,
  QUIETPAY_REFUND_SIGNER_PRIVATE_KEY: need("REFUND_SIGNER_PRIVATE_KEY"), QUIETPAY_MERCHANT_DATABASE_PATH: resolve(state, "store-merchant.db"),
  // Merchant wallet sign-in: the wallets allowed to open the dashboard. Default is the payout address; set
  // MERCHANT_WALLETS=0xYourMetaMaskAddress[,0x...] in the env file to allow your own.
  ...(process.env.MERCHANT_WALLETS ? { QUIETPAY_MERCHANT_WALLETS: process.env.MERCHANT_WALLETS } : {}),
  QUIETPAY_LEDGER_URL: `http://127.0.0.1:${LEDGER_PORT}`,
  QUIETPAY_BILLING: process.env.QUIETPAY_BILLING || "both", QUIETPAY_SUBSCRIPTIONS_FILE: resolve(state, "store-subscriptions.json"),
  QUIETPAY_AUTH_DOMAIN: "localhost:5174", QUIETPAY_AUTH_URI: "http://localhost:5174",
});

// x402 paid API (demo resources GET /v1/quote 0.01 USDT and /v1/signal 0.02 USDT), settled by the facilitator above.
start("paid-api", "apps/paid-api", ["--import", "tsx", "src/main.ts"], {
  PAID_API_PUBLIC_URL: paidApiUrl, FACILITATOR_URL: `http://127.0.0.1:${RELAYER_PORT}`, QUIETPAY_API_KEY: merchantApiKey,
  FACILITATOR_MERCHANT_ID: merchantId, FACILITATOR_PAYTO: payTo, CHAIN_ID: "1874", USDT_ADDRESS: usdt, PAID_API_PORT: String(PAID_API_PORT),
});

start("web", "apps/demo-store", [resolve(root, "apps/demo-store/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "5173"], {
  VITE_RELAYER_URL: `http://127.0.0.1:${RELAYER_PORT}`,
});

start("dashboard", "apps/merchant-dashboard", [resolve(root, "apps/merchant-dashboard/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "5174"], { VITE_STORE_URL: "http://localhost:5173" });

writeFileSync(resolve(tmp, "pids.json"), JSON.stringify(children.map((c) => c.pid)));
console.log(`\nQuietPay demo starting (logs: ${resolve(tmp, "logs")})`);
console.log("  Store UI   http://localhost:5173   (customers)");
console.log("  Dashboard  http://localhost:5174   (merchant: sign in with MetaMask)");
console.log(`  Paid API   ${paidApiUrl}/v1/quote  (x402 agent payments, settled gaslessly by the facilitator on ${RELAYER_PORT})`);
console.log(`  Store API  http://127.0.0.1:3001   Relayer http://127.0.0.1:${RELAYER_PORT}   Ledger http://127.0.0.1:${LEDGER_PORT} (first start reads the chain, about a minute)`);
console.log(`  Dashboard access token for merchant refunds: kept in memory only; print it with --show-token`);
const allowed = (process.env.MERCHANT_WALLETS || need("MERCHANT_PAYOUT_ADDRESS")).split(",").map((x) => x.trim()).filter(Boolean);
console.log(`  Merchant wallets allowed to sign in to the dashboard: ${allowed.join(", ")}`);
console.log(`  Customer payments are paid out to: ${process.env.MERCHANT_PAYOUT_ADDRESS} (the registered merchant payout)`);
console.log("  To allow another MetaMask account, put MERCHANT_WALLETS=0xAddress in the env file and restart.");
if (process.argv.includes("--show-token")) console.log(`  token: ${dashboardToken}`);

const stop = () => {
  for (const c of children) {
    try { c.kill(); } catch { /* already gone */ }
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
