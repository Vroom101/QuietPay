/**
 * Lead tooling findings A, B, D (local only; loopback stubs, throwaway keys, no public network).
 *  A: first-payment.mjs must verify the relayer's checkout before signing.
 *  B: live-payment.mjs must only accept the qualifying router and always assert chain 1874.
 *  D: record-deployment.mjs and qualify-check.ts must read the router back from chain.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionResult, keccak256, stringToHex, toFunctionSelector, type Address, type Hex } from "viem";
import { QUALIFYING_USDT, computePayNonce, getQualifyingDeployment, paymentRouterAbi } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = join(HERE, "..");
const ROOT = join(SHARED, "..", "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function run(script: string, cwd: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, script], {
      cwd,
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      r({ server, url: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}` });
    }),
  );
}

const dep = getQualifyingDeployment();
const MERCHANT = ("0x" + "ab".repeat(32)) as Hex;
const ORDER_ID = ("0x" + "cd".repeat(32)) as Hex;
const PAYOUT = "0x8DEA71e7930b45648Dc9d2E8fEc742F56B329425" as Address;

// ---------------------------------------------------------------- A: first-payment.mjs

let relayer: { server: Server; url: string };
let hits: string[] = [];
let checkout: Record<string, unknown> = {};

function goodCheckout(over: Record<string, unknown> = {}) {
  const nonce = computePayNonce({ merchantId: MERCHANT, orderId: ORDER_ID, payout: PAYOUT, value: 1_000_000n, fee: 50_000n });
  return {
    chainId: 1874,
    token: QUALIFYING_USDT,
    router: dep.router,
    value: "1000000",
    nonce,
    payout: PAYOUT,
    fee: "50000",
    domain: { name: "Tether USD", version: "1" },
    ...over,
  };
}

beforeAll(async () => {
  relayer = await listen((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/v1/orders") {
        res.end(JSON.stringify({ id: ORDER_ID, merchantId: MERCHANT, amount: "1000000", status: "created", checkout }));
      } else if (req.method === "POST" && req.url === "/v1/relay/pay") {
        res.end(JSON.stringify({ txHash: "0x" + "11".repeat(32) }));
      } else if (req.method === "GET" && req.url?.startsWith("/v1/orders/")) {
        res.end(JSON.stringify({ status: "settled", txHash: "0x" + "11".repeat(32) }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
});
afterAll(() => new Promise<void>((r) => relayer.server.close(() => r())));

function runFirstPayment(extra: Record<string, string> = {}) {
  return run("scripts/first-payment.mjs", SHARED, {
    RELAYER_URL: relayer.url,
    QUIETPAY_API_KEY: "k",
    QUIETPAY_MERCHANT_ID: MERCHANT,
    PAYER_PRIVATE_KEY: generatePrivateKey(),
    AMOUNT: "1000000",
    ...extra,
  });
}

describe("A: first-payment.mjs verifies the checkout before signing", () => {
  it("[control] a qualifying checkout is signed and relayed", async () => {
    hits = [];
    checkout = goodCheckout();
    const r = await runFirstPayment();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(hits).toContain("POST /v1/relay/pay");
  }, 60_000);

  const hostile: [string, Record<string, unknown>][] = [
    ["router", { router: "0x" + "11".repeat(20) }],
    ["token", { token: "0x" + "22".repeat(20) }],
    ["chainId", { chainId: 1 }],
    ["value", { value: "9000000" }],
    ["fee above the cap", { fee: "5000000" }],
    ["fee at or above the value", { fee: "1000000" }],
    ["missing payout", { payout: undefined }],
    ["zero payout", { payout: "0x" + "00".repeat(20) }],
  ];
  for (const [name, over] of hostile) {
    it(`a hostile ${name} is refused without calling /v1/relay/pay`, async () => {
      hits = [];
      checkout = goodCheckout(over);
      const r = await runFirstPayment();
      expect(r.code).not.toBe(0);
      expect(hits).not.toContain("POST /v1/relay/pay");
    }, 60_000);
  }

  it("a non-https, non-loopback RELAYER_URL is refused before any request", async () => {
    hits = [];
    checkout = goodCheckout();
    const r = await runFirstPayment({ RELAYER_URL: "http://relayer.example.com" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/https|localhost/i);
    expect(hits).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------- B: live-payment.mjs

describe("B: live-payment.mjs only accepts the qualifying router and always asserts chain 1874", () => {
  let rpc: { server: Server; url: string };
  let methods: string[] = [];
  let nodeChain = "0x752";
  beforeAll(async () => {
    rpc = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = JSON.parse(body);
        methods.push(m.method);
        res.setHeader("content-type", "application/json");
        const result = m.method === "eth_chainId" ? nodeChain : undefined;
        res.end(JSON.stringify(result ? { jsonrpc: "2.0", id: m.id, result } : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "stub" } }));
      });
    });
  });
  afterAll(() => new Promise<void>((r) => rpc.server.close(() => r())));

  const base = () => ({
    RPC_URL: rpc.url,
    ROUTER_ADDRESS: dep.router,
    USDT_ADDRESS: QUALIFYING_USDT,
    PAYER_PRIVATE_KEY: generatePrivateKey(),
    RELAYER_PRIVATE_KEY: generatePrivateKey(),
  });

  it("[control] the qualifying router passes the guard and reaches the chain", async () => {
    methods = [];
    nodeChain = "0x752";
    const r = await run("scripts/live-payment.mjs", SHARED, base());
    expect(r.code).not.toBe(0); // the stub fails everything but chainId
    expect(methods.filter((m) => m !== "eth_chainId").length).toBeGreaterThan(0);
  }, 60_000);

  it("another ROUTER_ADDRESS on chain 1874 is refused before any chain read", async () => {
    methods = [];
    nodeChain = "0x752";
    const r = await run("scripts/live-payment.mjs", SHARED, { ...base(), ROUTER_ADDRESS: "0x" + "11".repeat(20) });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/qualifying router/i);
    expect(methods.filter((m) => m !== "eth_chainId")).toEqual([]);
  }, 60_000);

  it("a CHAIN_ID env other than 1874 cannot skip the qualifying checks", async () => {
    methods = [];
    nodeChain = "0x752";
    const r = await run("scripts/live-payment.mjs", SHARED, { ...base(), CHAIN_ID: "31337", ROUTER_ADDRESS: "0x" + "11".repeat(20), USDT_ADDRESS: "0x" + "22".repeat(20) });
    expect(r.code).not.toBe(0);
    expect(methods.filter((m) => m !== "eth_chainId")).toEqual([]);
  }, 60_000);

  it("a node that reports another chain is refused", async () => {
    methods = [];
    nodeChain = "0x1";
    const r = await run("scripts/live-payment.mjs", SHARED, base());
    nodeChain = "0x752";
    expect(r.code).not.toBe(0);
    expect(methods.filter((m) => m !== "eth_chainId")).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------- D: record-deployment.mjs and qualify-check.ts

const OWNER = "0x1E009f4fecE682514fCD5F284CaDdB1f46b10e2D" as Address;
const RELAYER = "0x5e97E3E39ba9DaBbc1297392a2eE62A139F1ceeA" as Address;
const REFUND_SIGNER = "0xeF70298c52b917d2301F7331bfe7038550d2CD5d" as Address;
const NEW_ROUTER = "0x" + "77".repeat(20);
const DEPLOY_TX = "0x" + "99".repeat(32);

type Chain = { owner: Address; payout: Address; refundSigner: Address; relayerOk: boolean; token: Address };
let chain: Chain;
let rpcD: { server: Server; url: string };

function sel(name: string) {
  const item = paymentRouterAbi.find((x) => x.type === "function" && x.name === name)!;
  return toFunctionSelector(item as never);
}

beforeAll(async () => {
  rpcD = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body);
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
      let out: unknown;
      if (m.method === "eth_chainId") out = ok("0x752");
      else if (m.method === "eth_getTransactionReceipt")
        out = ok({
          blockHash: "0x" + "aa".repeat(32), blockNumber: "0x10", contractAddress: NEW_ROUTER, cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1",
          from: OWNER, gasUsed: "0x1", logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", to: null, transactionHash: DEPLOY_TX,
          transactionIndex: "0x0", type: "0x0",
        });
      else if (m.method === "eth_getCode") out = ok("0x6001");
      else if (m.method === "eth_call") {
        const data: string = m.params[0].data ?? m.params[0].input;
        const s = data.slice(0, 10);
        const fn = (name: string, value: unknown) => ok(encodeFunctionResult({ abi: paymentRouterAbi, functionName: name as never, result: value as never }));
        if (s === sel("owner")) out = fn("owner", chain.owner);
        else if (s === sel("token")) out = fn("token", chain.token);
        else if (s === sel("isRelayer")) out = fn("isRelayer", chain.relayerOk);
        else if (s === sel("merchants")) out = fn("merchants", [chain.payout, chain.refundSigner, 100000n]);
        else out = { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "stub: unknown call" } };
      } else out = { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "stub: not served" } };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
});
afterAll(() => new Promise<void>((r) => rpcD.server.close(() => r())));

function goodChain(): Chain {
  return { owner: OWNER, payout: PAYOUT, refundSigner: REFUND_SIGNER, relayerOk: true, token: QUALIFYING_USDT as Address };
}

describe("D: record-deployment.mjs reads the router back from chain", () => {
  let tmp: string;
  let broadcast: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "qp-record-"));
    mkdirSync(join(tmp, "contracts"), { recursive: true });
    mkdirSync(join(tmp, "packages", "shared", "src"), { recursive: true });
    writeFileSync(join(tmp, "contracts", "deployments.json"), JSON.stringify({ 1874: { router: "0x" + "01".repeat(20) } }));
    broadcast = join(tmp, "run.json");
    writeFileSync(broadcast, JSON.stringify({ receipts: [{ transactionHash: DEPLOY_TX, contractAddress: NEW_ROUTER }] }));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const env = (over: Record<string, string> = {}) => ({
    RPC_URL: rpcD.url, OWNER_ADDRESS: OWNER, RELAYER_ADDRESS: RELAYER, MERCHANT_PAYOUT: PAYOUT, REFUND_SIGNER: REFUND_SIGNER,
    DEPLOYMENTS_ROOT: tmp, ...over,
  });
  const recorded = () => JSON.parse(readFileSync(join(tmp, "contracts", "deployments.json"), "utf8"))["1874"].router as string;

  it("[control] values that match the chain are recorded", async () => {
    chain = goodChain();
    const r2 = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const c = spawn(process.execPath, [TSX, "scripts/record-deployment.mjs", broadcast], { cwd: SHARED, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env() } });
      let stderr = "";
      c.stderr.on("data", (d) => (stderr += d));
      c.on("close", (code) => resolve({ code, stderr }));
    });
    expect(r2.stderr).toBe("");
    expect(r2.code).toBe(0);
    expect(recorded().toLowerCase()).toBe(NEW_ROUTER.toLowerCase());
  }, 60_000);

  const mismatches: [string, (c: Chain) => void][] = [
    ["owner", (c) => (c.owner = "0x" + "12".repeat(20) as Address)],
    ["payout", (c) => (c.payout = "0x" + "13".repeat(20) as Address)],
    ["refundSigner", (c) => (c.refundSigner = "0x" + "14".repeat(20) as Address)],
    ["relayer allowlist", (c) => (c.relayerOk = false)],
    ["token", (c) => (c.token = "0x" + "15".repeat(20) as Address)],
  ];
  for (const [name, mutate] of mismatches) {
    it(`refuses to record when the on-chain ${name} differs from the env`, async () => {
      writeFileSync(join(tmp, "contracts", "deployments.json"), JSON.stringify({ 1874: { router: "0x" + "01".repeat(20) } }));
      chain = goodChain();
      mutate(chain);
      const r2 = await new Promise<{ code: number | null }>((resolve) => {
        const c = spawn(process.execPath, [TSX, "scripts/record-deployment.mjs", broadcast], { cwd: SHARED, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env() } });
        c.on("close", (code) => resolve({ code }));
      });
      expect(r2.code).not.toBe(0);
      expect(recorded()).toBe("0x" + "01".repeat(20));
    }, 60_000);
  }
});

describe("D: qualify-check.ts checks router.token() on chain when RPC_URL is set", () => {
  let explorer: { server: Server; url: string };
  beforeAll(async () => {
    explorer = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ is_verified: true }));
    });
  });
  afterAll(() => new Promise<void>((r) => explorer.server.close(() => r())));

  const qc = (extra: Record<string, string>) =>
    run("scripts/qualify-check.ts", ROOT, { RPC_URL: rpcD.url, EXPLORER_API_BASE: explorer.url, ...extra });

  it("PASS when the router's token() is the official USDT", async () => {
    chain = goodChain();
    const r = await qc({});
    expect(r.stdout).toMatch(/\[PASS\s*\] router on-chain token matches/);
  }, 120_000);

  it("FAIL (exit 1) when the router's token() differs", async () => {
    chain = goodChain();
    chain.token = ("0x" + "15".repeat(20)) as Address;
    const r = await qc({});
    expect(r.stdout).toMatch(/\[FAIL\s*\] router on-chain token matches/);
    expect(r.code).toBe(1);
  }, 120_000);
});

void keccak256; void stringToHex; void privateKeyToAccount;
