import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const yamlKeys = (p: string) => new Set([...read(p).matchAll(/key:\s*([A-Z0-9_]+)/g)].map((m) => m[1]!));
const envKeys = new Set([...read(".env.example").matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]!));

// Every environment variable the relayer and facilitator read (docs/b/build/config-matrix.md sections 1 and 2).
const RELAYER = [
  "RPC_URL", "CHAIN_ID", "USDT_ADDRESS", "ROUTER_ADDRESS", "RELAYER_PRIVATE_KEY", "OPERATOR_TOKEN", "MERCHANT_API_KEYS", "WEBHOOK_SECRET",
  "ALLOW_PRIVATE_WEBHOOKS", "DATABASE_PATH", "LOSS_BUDGET_WBT_PER_HOUR", "MAX_GAS_PRICE", "PAYER_CAP_USDT", "MAX_GAS_LIMIT", "LOW_BALANCE_WBT",
  "PENDING_RETRY_SECONDS", "MAX_REPLACEMENTS", "SETTLE_CONFIRMATIONS", "RELAY_FEE_USDT", "RATE_LIMIT_PER_MINUTE", "EXPLORER_BASE_URL",
  "TOKEN_DOMAIN_NAME", "TOKEN_DOMAIN_VERSION", "PORT", "MIN_VALID_SECONDS", "REVERTED_PAYER_MIN_VALID_SECONDS", "MAX_REVERTS_PER_DAY",
  "PAYER_LOSS_SHARE_PERCENT", "TX_MAX_AGE_SECONDS", "FIRST_TIME_PAYER_LOSS_SHARE_PERCENT", "FIRST_TIME_PAYER_LOSS_CAP_PERCENT",
  "MAX_NEW_PAYERS_PER_IP_PER_HOUR", "TRUST_PROXY_HOPS", "RECONCILE_INTERVAL_SECONDS", "CORS_ORIGINS",
];
const FACILITATOR = ["PAID_API_PUBLIC_URL", "FACILITATOR_PAYTO", "FACILITATOR_MERCHANT_ID", "X402_SETTLEMENT_WAIT_MS", "X402_QUOTE_AMOUNT", "X402_SIGNAL_AMOUNT"];
const SECRETS = ["RELAYER_PRIVATE_KEY", "OPERATOR_TOKEN", "MERCHANT_API_KEYS", "WEBHOOK_SECRET", "QUIETPAY_API_KEY", "QUIETPAY_WEBHOOK_SECRET", "QUIETPAY_REFUND_SIGNER_PRIVATE_KEY", "QUIETPAY_DASHBOARD_TOKEN"];

describe("Feature: config names match across code, blueprints and .env.example", () => {
  it.each(["render.yaml", "render.facilitator.yaml", "deploy/render.yaml"])("%s names every relayer variable", (file) => {
    const keys = yamlKeys(file);
    const facilitator = file !== "render.yaml";
    const want = facilitator ? [...RELAYER, ...FACILITATOR] : RELAYER;
    expect(want.filter((n) => !keys.has(n))).toEqual([]);
  });

  it("deploy/render.yaml covers the paid API, merchant server and indexer API with the matrix names", () => {
    const keys = yamlKeys("deploy/render.yaml");
    for (const n of ["PAID_API_PORT", "FACILITATOR_URL", "QUIETPAY_API_KEY", "QUIETPAY_WEBHOOK_SECRET", "QUIETPAY_STATE_FILE", "QUIETPAY_RECEIPT_DATABASE_PATH", "QUIETPAY_MERCHANT_DATABASE_PATH", "INDEXER_FROM_BLOCK", "INDEXER_DATABASE_PATH", "INDEXER_PORT", "INDEXER_CONFIRMATIONS", "INDEXER_POLL_MS", "HOST", "BACKUP_DIR", "BACKUP_KEEP"]) {
      expect(keys.has(n), n).toBe(true);
    }
  });

  it(".env.example lists every relayer, facilitator, merchant-server and indexer name", () => {
    const want = [...RELAYER, ...FACILITATOR, "QUIETPAY_BASE_URL", "QUIETPAY_WEBHOOK_SECRET", "QUIETPAY_STATE_FILE", "INDEXER_FROM_BLOCK", "BACKUP_DIR", "HOST", "DEPLOY_BLOCK", "POLL_SECONDS"];
    expect(want.filter((n) => !envKeys.has(n))).toEqual([]);
  });

  it("secrets are placeholders everywhere: sync:false in blueprints, empty in .env.example", () => {
    for (const f of ["render.yaml", "render.facilitator.yaml", "deploy/render.yaml"]) {
      for (const m of read(f).matchAll(/key:\s*([A-Z0-9_]+),\s*value:/g)) expect(SECRETS, `${f} ${m[1]}`).not.toContain(m[1]);
    }
    for (const s of SECRETS) {
      const line = read(".env.example").match(new RegExp(`^${s}=(.*)$`, "m"));
      if (line) expect(line[1]!.trim(), s).toBe("");
    }
  });

  it("the relayer service is one instance with a persistent disk and the /v1/health check", () => {
    const y = read("deploy/render.yaml");
    const block = y.slice(y.indexOf("name: quietpay-relayer"), y.indexOf("name: quietpay-paid-api"));
    expect(block).toMatch(/numInstances:\s*1\b/);
    expect(block).toMatch(/healthCheckPath:\s*\/v1\/health/);
    expect(block).toMatch(/disk:\s*\{[^}]*mountPath:\s*\/data/);
    expect(block).toMatch(/DATABASE_PATH,\s*value:\s*\/data\//);
    expect(block).toMatch(/ALLOW_PRIVATE_WEBHOOKS,\s*value:\s*"0"/);
  });

  it("the image pins Node and pnpm and installs from the lockfile", () => {
    const d = read("deploy/Dockerfile");
    expect(d).toMatch(/^FROM node:\d+\.\d+\.\d+-/m);
    expect(d).toMatch(/pnpm@\d+\.\d+\.\d+/);
    expect(d).toContain("--frozen-lockfile");
  });
});
