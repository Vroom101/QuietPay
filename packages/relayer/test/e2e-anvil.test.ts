import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildCheckoutAuthorization, merchantIdFromSlug, paymentRouterAbi, type Order } from "@quietpay/shared";
import { verifyWebhookSignature, WebhookEvent } from "@quietpay/shared/webhook";
import { Db } from "../src/db.js";
import { makeChain } from "../src/chain.js";
import { RelayerService } from "../src/service.js";
import { buildServer } from "../src/server.js";
import { WebhookWorker } from "../src/webhooks.js";
import { makeCfg } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.CONTRACTS_OUT ?? resolve(here, "../../../contracts/out");
const routerArtifact = resolve(out, "PaymentRouter.sol/PaymentRouter.json");
const usdtArtifact = resolve(out, "MockUSDT.sol/MockUSDT.json");
const haveArtifacts = existsSync(routerArtifact) && existsSync(usdtArtifact);

// Standard anvil dev keys (public, test-only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const PAYOUT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Hex;
const PORT = 18545;
const RPC = `http://127.0.0.1:${PORT}`;

describe.skipIf(!haveArtifacts)("end to end on anvil: zero-WBT payer, real router, signed webhook", () => {
  let anvil: ChildProcess;
  let hookServer: Server;
  const hooks: { body: string; sig: string }[] = [];

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
        if (r.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    hookServer = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        hooks.push({ body: b, sig: String(req.headers["quietpay-signature"]) });
        res.writeHead(200).end("ok");
      });
    }).listen(18546);
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
    hookServer?.close();
  });

  it("settles a payment from a payer with no native balance", async () => {
    const deployer = privateKeyToAccount(DEPLOYER_KEY);
    const relayer = privateKeyToAccount(RELAYER_KEY);
    const chainDef = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
    const pub = createPublicClient({ chain: chainDef, transport: http(RPC) });
    const wallet = createWalletClient({ account: deployer, chain: chainDef, transport: http(RPC) });

    const load = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const usdtJson = load(usdtArtifact);
    const routerJson = load(routerArtifact);

    const usdtHash = await wallet.deployContract({ abi: usdtJson.abi, bytecode: usdtJson.bytecode.object });
    const usdt = (await pub.waitForTransactionReceipt({ hash: usdtHash })).contractAddress!;
    const routerHash = await wallet.deployContract({
      abi: routerJson.abi,
      bytecode: routerJson.bytecode.object,
      args: [usdt, deployer.address],
    });
    const router = (await pub.waitForTransactionReceipt({ hash: routerHash })).contractAddress!;

    const merchantId = merchantIdFromSlug("demo-store");
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "registerMerchant", args: [merchantId, PAYOUT, PAYOUT, 100_000n] }),
    });
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "setRelayer", args: [relayer.address, true] }),
    });

    // A brand new payer: holds USDT, holds no native gas token.
    const payerKey = generatePrivateKey();
    const payer = privateKeyToAccount(payerKey);
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: usdt, abi: usdtJson.abi, functionName: "mint", args: [payer.address, parseUnits("100", 6)] }),
    });
    expect(await pub.getBalance({ address: payer.address })).toBe(0n);

    // Relayer service on the real chain adapter.
    const cfg = makeCfg({
      rpcUrl: RPC,
      chainId: 31337,
      usdt,
      router,
      relayerKey: RELAYER_KEY,
      apiKeys: new Map([["test-key", merchantId]]),
      lossBudgetWei: parseUnits("1", 18),
    });
    const db = new Db(":memory:");
    const svc = new RelayerService({ cfg, db, chain: makeChain({ rpcUrl: RPC, chainId: 31337, router, relayerKey: RELAYER_KEY }) });
    const worker = new WebhookWorker(db, cfg.webhookSecret);
    const app = buildServer(svc);

    // Merchant creates the order over HTTP with its API key.
    const created = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { authorization: "Bearer test-key" },
      payload: { merchantId, amount: "25000000", reference: "e2e-1", webhookUrl: "http://127.0.0.1:18546/hook" },
    });
    expect(created.statusCode).toBe(201);
    const order = created.json() as Order;
    expect(order.fee).toBe("50000");

    // Payer signs once.
    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 30;
    const validBefore = now + 300;
    const signature = await payer.signTypedData(
      buildCheckoutAuthorization({
        from: payer.address,
        router,
        value: BigInt(order.amount),
        nonce: order.checkout.nonce as Hex,
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        chainId: 31337,
        token: usdt,
      }),
    );

    const relay = await app.inject({
      method: "POST",
      url: "/v1/relay/pay",
      payload: { orderId: order.id, payer: payer.address, validAfter, validBefore, signature, amount: order.amount },
    });
    expect(relay.statusCode, relay.body).toBe(200);
    const { txHash } = relay.json();
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Repeating returns the same hash.
    const repeat = await app.inject({
      method: "POST",
      url: "/v1/relay/pay",
      payload: { orderId: order.id, payer: payer.address, validAfter, validBefore, signature },
    });
    expect(repeat.json().txHash).toBe(txHash);

    // Poll until settled.
    let settled: Order | undefined;
    for (let i = 0; i < 40; i++) {
      const o = (await app.inject({ method: "GET", url: `/v1/orders/${order.id}` })).json() as Order;
      if (o.status === "settled") {
        settled = o;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(settled?.status).toBe("settled");
    expect(settled?.explorerUrl).toContain(txHash);

    // Money moved exactly as specified; the payer still has no native balance.
    const bal = (a: Hex) => pub.readContract({ address: usdt, abi: usdtJson.abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
    expect(await bal(payer.address)).toBe(parseUnits("100", 6) - 25_000_000n);
    expect(await bal(PAYOUT)).toBe(25_000_000n - 50_000n);
    expect(await bal(relayer.address)).toBe(50_000n);
    expect(await bal(router)).toBe(0n);
    expect(await pub.getBalance({ address: payer.address })).toBe(0n);

    // A second payment for the same order, even with a fresh valid signature, is rejected.
    const vb2 = validBefore - 5;
    const signature2 = await payer.signTypedData(
      buildCheckoutAuthorization({
        from: payer.address,
        router,
        value: BigInt(order.amount),
        nonce: order.checkout.nonce as Hex,
        validAfter: BigInt(validAfter),
        validBefore: BigInt(vb2),
        chainId: 31337,
        token: usdt,
      }),
    );
    const again = await app.inject({
      method: "POST",
      url: "/v1/relay/pay",
      payload: { orderId: order.id, payer: payer.address, validAfter, validBefore: vb2, signature: signature2 },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("already_settled");

    // Health reflects the router and the unpaused state.
    const health = (await app.inject({ method: "GET", url: "/v1/health" })).json();
    expect(health.router.toLowerCase()).toBe(router.toLowerCase());
    expect(health.paused).toBe(false);

    // Signed webhook is delivered and verifies.
    expect(await worker.tick()).toBe(1);
    expect(hooks).toHaveLength(1);
    expect(verifyWebhookSignature(cfg.webhookSecret, hooks[0]!.body, hooks[0]!.sig)).toBe(true);
    const event = WebhookEvent.parse(JSON.parse(hooks[0]!.body));
    expect(event.type).toBe("payment.settled");
    expect(event.data.txHash).toBe(txHash);
    expect(await worker.tick()).toBe(0); // delivered once, not redelivered
  }, 60_000);
});
