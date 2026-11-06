import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import * as merchantSdk from "../../merchant-sdk/src/index.js";
import { buildApp as buildStore } from "../../../apps/demo-store/server/app.js";
import { preflight } from "../src/preflight.js";
import { makeCfg } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.CONTRACTS_OUT ?? resolve(here, "../../../contracts/out");
const routerArtifact = resolve(out, "PaymentRouter.sol/PaymentRouter.json");
const usdtArtifact = resolve(out, "MockUSDT.sol/MockUSDT.json");
const haveArtifacts = existsSync(routerArtifact) && existsSync(usdtArtifact);
const anvilBin = process.env.ANVIL_BIN ?? "anvil";
const haveAnvil = spawnSync(anvilBin, ["--version"], { stdio: "ignore" }).status === 0;
if (process.env.CI && (!haveArtifacts || !haveAnvil)) throw new Error("CI integration requires built contract artifacts and anvil on PATH (or ANVIL_BIN).");

// Standard anvil dev keys (public, test-only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const PAYOUT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Hex;
const PORT = 18545;
const RPC = `http://127.0.0.1:${PORT}`;

describe.skipIf(!haveArtifacts || !haveAnvil)("end to end on anvil: zero-WBT payer, real router, signed webhook", () => {
  let anvil: ChildProcess;
  let hookServer: Server;
  let relayerApp: ReturnType<typeof buildServer> | undefined;
  let storeApp: ReturnType<typeof buildStore> | undefined;
  let merchantHookUrl: string | undefined;
  const hooks: { body: string; sig: string }[] = [];

  beforeAll(async () => {
    anvil = spawn(anvilBin, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
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
      req.on("end", async () => {
        hooks.push({ body: b, sig: String(req.headers["quietpay-signature"]) });
        try {
          if (merchantHookUrl) {
            const delivered = await fetch(merchantHookUrl, { method: "POST", headers: {
              "content-type": "application/json", "quietpay-signature": String(req.headers["quietpay-signature"]),
            }, body: b });
            res.writeHead(delivered.status).end(await delivered.text());
          } else res.writeHead(503).end("merchant not ready");
        } catch { res.writeHead(502).end("merchant unreachable"); }
      });
    }).listen(18546);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([relayerApp?.close(), storeApp?.close()]);
    anvil?.kill();
    hookServer?.close();
  });

  it("checks every HTTP route and settles store checkout, partial/full refunds and verified webhooks", async () => {
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
    const refundKey = generatePrivateKey();
    const refundSigner = privateKeyToAccount(refundKey);
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "registerMerchant", args: [merchantId, PAYOUT, refundSigner.address, 100_000n] }),
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

    relayerApp = app;
    expect(await preflight(cfg)).toMatchObject({ ok: true, chainId: 31337, paused: false });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = async (opts: { method?: "GET" | "POST" | "OPTIONS"; url: string;
      headers?: Record<string, string>; payload?: unknown }) => {
      const res = await fetch(baseUrl + opts.url, { method: opts.method ?? "GET",
        headers: { ...(opts.payload === undefined ? {} : { "content-type": "application/json" }), ...opts.headers },
        body: opts.payload === undefined ? undefined : JSON.stringify(opts.payload) });
      const body = await res.text();
      return { statusCode: res.status, headers: res.headers, body, json: () => JSON.parse(body) };
    };
    const auth = { authorization: "Bearer test-key" };
    const op = { authorization: `Bearer ${cfg.operatorToken}` };
    const unknown = "0x" + "ee".repeat(32);
    for (const url of ["/v1/orders", "/v1/metrics", `/v1/orders/${unknown}/refund-context`,
      `/v1/orders/${unknown}/refunds`, `/v1/refunds/${unknown}`]) {
      expect((await request({ url })).statusCode, url).toBe(401);
      expect((await request({ url, headers: { authorization: "Bearer wrong" } })).statusCode, url).toBe(401);
    }
    for (const url of ["/v1/orders", "/v1/admin/pause", "/v1/relay/refund"]) {
      expect((await request({ method: "POST", url, payload: {} })).statusCode, url).toBe(401);
    }
    expect((await request({ url: `/v1/orders/${unknown}` })).statusCode).toBe(404);
    expect((await request({ method: "POST", url: "/v1/orders", headers: auth,
      payload: { merchantId: unknown, amount: "1000000" } })).statusCode).toBe(403);
    const created = await request({ method: "POST", url: "/v1/orders", headers: auth,
      payload: { merchantId, amount: "1000000", reference: "api-smoke" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: "created", amount: "1000000" });
    expect((await request({ method: "POST", url: "/v1/relay/pay", payload: {} })).statusCode).toBe(400);
    expect((await request({ method: "POST", url: "/v1/relay/refund", headers: auth, payload: {} })).statusCode).toBe(400);
    const options = await request({ method: "OPTIONS", url: "/v1/relay/pay" });
    expect(options.statusCode).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");

    // A running demo store calls the real SDK, which calls the running relayer.
    const store = buildStore(merchantSdk, { baseUrl, apiKey: "test-key", merchantId,
      webhookSecret: cfg.webhookSecret, webhookUrl: "http://127.0.0.1:18546/hook",
      refunds: { dashboardToken: "merchant-dashboard-test-access-token-32-characters", router,
        refundSignerPrivateKey: refundKey, databasePath: ":memory:", chainId: 31337, tokenAddress: usdt } });
    storeApp = store;
    const storeUrl = await store.listen({ host: "127.0.0.1", port: 0 });
    merchantHookUrl = `${storeUrl}/webhooks/quietpay`;
    expect((await fetch(`${storeUrl}/api/checkout`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cartTotal: "-1" }) })).status).toBe(400);
    const checkout = await fetch(`${storeUrl}/api/checkout`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: { tee: 1 }, cartTotal: "25.00" }) });
    expect(checkout.status).toBe(200);
    const { orderId } = await checkout.json() as { orderId: Hex };
    const orderRead = await request({ url: `/v1/orders/${orderId}` });
    expect(orderRead.statusCode).toBe(200);
    const order = orderRead.json() as Order;
    expect(order.amount).toBe("25000000");
    expect(order.fee).toBe("50000");
    const orders = await request({ url: "/v1/orders", headers: auth });
    expect(orders.statusCode).toBe(200);
    expect(orders.json().orders.some((o: Order) => o.id === order.id)).toBe(true);
    expect((await fetch(`${storeUrl}/api/orders/${order.id}/paid`)).status).toBe(200);
    expect(await (await fetch(`${storeUrl}/api/orders/${order.id}/paid`)).json()).toMatchObject({ paid: false });
    expect((await request({ url: `/v1/orders/${order.id}/refund-context`, headers: auth })).statusCode).toBe(422);

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

    const payPayload = { orderId: order.id, payer: payer.address, validAfter, validBefore, signature, amount: order.amount };
    const nonceBefore = await pub.getTransactionCount({ address: relayer.address, blockTag: "pending" });
    expect((await request({ method: "POST", url: "/v1/admin/pause", headers: op, payload: { paused: true } })).statusCode).toBe(200);
    const blocked = await request({ method: "POST", url: "/v1/relay/pay", payload: payPayload });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().error.code).toBe("relayer_paused");
    expect(await pub.getTransactionCount({ address: relayer.address, blockTag: "pending" })).toBe(nonceBefore);
    expect((await request({ method: "POST", url: "/v1/admin/pause", headers: op, payload: { paused: false } })).statusCode).toBe(200);
    const mismatched = await request({ method: "POST", url: "/v1/relay/pay", payload: { ...payPayload, amount: "1" } });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error.code).toBe("amount_mismatch");

    const relay = await request({
      method: "POST",
      url: "/v1/relay/pay",
      payload: { orderId: order.id, payer: payer.address, validAfter, validBefore, signature, amount: order.amount },
    });
    expect(relay.statusCode, relay.body).toBe(200);
    const { txHash } = relay.json();
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Settlement requires two confirmations; Anvil mines only when asked or sent a transaction.
    await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }) });

    // Repeating returns the same hash.
    const repeat = await request({
      method: "POST",
      url: "/v1/relay/pay",
      payload: { orderId: order.id, payer: payer.address, validAfter, validBefore, signature },
    });
    expect(repeat.json().txHash).toBe(txHash);

    // Poll until settled.
    let settled: Order | undefined;
    for (let i = 0; i < 40; i++) {
      const o = (await request({ method: "GET", url: `/v1/orders/${order.id}` })).json() as Order;
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
    const again = await request({
      method: "POST",
      url: "/v1/relay/pay",
      payload: { orderId: order.id, payer: payer.address, validAfter, validBefore: vb2, signature: signature2 },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("already_settled");

    // Health reflects the router and the unpaused state.
    const health = (await request({ method: "GET", url: "/v1/health" })).json();
    expect(health.router.toLowerCase()).toBe(router.toLowerCase());
    expect(health.paused).toBe(false);

    // Signed webhook is delivered and verifies.
    expect(await (await fetch(`${storeUrl}/api/orders/${order.id}/paid`)).json()).toEqual({ paid: false });
    expect(await worker.tick()).toBe(1);
    expect(hooks).toHaveLength(1);
    expect(verifyWebhookSignature(cfg.webhookSecret, hooks[0]!.body, hooks[0]!.sig)).toBe(true);
    const event = WebhookEvent.parse(JSON.parse(hooks[0]!.body));
    expect(event.type).toBe("payment.settled");
    expect(event.data.txHash).toBe(txHash);
    expect(await (await fetch(`${storeUrl}/api/orders/${order.id}/paid`)).json()).toMatchObject({ paid: true, orderId: order.id, txHash });
    const delivered = hooks[0]!;
    const replay = await fetch(merchantHookUrl, { method: "POST", headers: { "content-type": "application/json", "quietpay-signature": delivered.sig }, body: delivered.body });
    expect(await replay.json()).toMatchObject({ received: true, duplicate: true });
    expect((await fetch(merchantHookUrl, { method: "POST", headers: { "content-type": "application/json", "quietpay-signature": delivered.sig },
      body: delivered.body.replace("25000000", "25000001") })).status).toBe(400);
    expect(await worker.tick()).toBe(0); // delivered once, not redelivered

    const merchantHeaders = { "content-type": "application/json", authorization: "Bearer merchant-dashboard-test-access-token-32-characters" };
    const refundEndpoint = `${storeUrl}/api/merchant/orders/${order.id}/refunds`;
    const partialRequest = { requestId: "11111111-1111-4111-8111-111111111111", amount: "5000000", refundIndex: 0 };
    expect((await fetch(`${storeUrl}/api/merchant/orders`)).status).toBe(401);
    expect((await fetch(refundEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(partialRequest) })).status).toBe(401);
    const merchantOrders = await fetch(`${storeUrl}/api/merchant/orders`, { headers: merchantHeaders });
    expect((await merchantOrders.json()).orders.some((o: Order) => o.id === order.id)).toBe(true);
    const unfunded = await fetch(refundEndpoint, { method: "POST", headers: merchantHeaders, body: JSON.stringify(partialRequest) });
    expect(unfunded.status).toBe(422);
    expect((await unfunded.json()).error.code).toBe("insufficient_refund_balance");

    // Fund a separate, zero-native-balance refund signer. Payout remains unchanged.
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdt,
      abi: usdtJson.abi, functionName: "mint", args: [refundSigner.address, 25_000_000n] }) });
    for (const [index, amount] of [[0, "5000000"], [1, "20000000"]] as const) {
      const businessRequest = index === 0 ? partialRequest : { requestId: "22222222-2222-4222-8222-222222222222", amount, refundIndex: index };
      const posted = await fetch(refundEndpoint, { method: "POST", headers: merchantHeaders, body: JSON.stringify(businessRequest) });
      expect(posted.status).toBe(202);
      const operation = await posted.json();
      const refund = operation.refund;
      expect(refund).toMatchObject({ amount, refundIndex: index, status: "pending" });
      const replayed = await fetch(refundEndpoint, { method: "POST", headers: merchantHeaders, body: JSON.stringify(businessRequest) });
      expect((await replayed.json()).refund.id).toBe(refund.id);
      await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3 + index, method: "evm_mine", params: [] }) });
      for (let i = 0; i < 50; i++) {
        if (svc.refunds.get(merchantId, refund.id).status === "settled") break;
        await new Promise(r => setTimeout(r, 100));
      }
      const refundRead = await request({ url: `/v1/refunds/${refund.id}`, headers: auth });
      expect(refundRead.statusCode).toBe(200);
      expect(refundRead.json()).toMatchObject({ id: refund.id, amount, status: "settled" });
      const history = await request({ url: `/v1/orders/${order.id}/refunds`, headers: auth });
      expect(history.statusCode).toBe(200);
      expect(history.json().refunds).toHaveLength(index + 1);
      const merchantView = await (await fetch(`${storeUrl}/api/merchant/orders/${order.id}/refund-context`, { headers: merchantHeaders })).json();
      expect(merchantView.requests[0].status).toBe("settled");
      expect(merchantView.context.refunded).toBe(index === 0 ? "5000000" : "25000000");
      const finalOrder = (await request({ url: `/v1/orders/${order.id}` })).json();
      expect(finalOrder.status).toBe(index === 0 ? "partially_refunded" : "refunded");
      expect(finalOrder.refundCount).toBe(index + 1);
      expect(await (await fetch(`${storeUrl}/api/orders/${order.id}/paid`)).json()).toMatchObject({
        paid: true, orderStatus: finalOrder.status, refunded: finalOrder.refunded, refundCount: index + 1,
      });
      expect(await worker.tick()).toBe(1);
      const delivery = hooks.at(-1)!;
      expect(verifyWebhookSignature(cfg.webhookSecret, delivery.body, delivery.sig)).toBe(true);
      expect(WebhookEvent.parse(JSON.parse(delivery.body))).toMatchObject({ type: "payment.refunded",
        data: { refundAmount: amount, refundIndex: index, payer: payer.address.toLowerCase() } });
    }
    const receipt = await pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "receipts", args: [merchantId, order.id as Hex] });
    expect(receipt.refunded).toBe(25_000_000n);
    expect(receipt.refundCount).toBe(2n);
    expect(await bal(payer.address)).toBe(parseUnits("100", 6));
    expect(await bal(PAYOUT)).toBe(25_000_000n - 50_000n);
    expect(await bal(relayer.address)).toBe(50_000n);
    expect(await bal(router)).toBe(0n);
    expect(await bal(refundSigner.address)).toBe(0n);
    expect(await pub.getBalance({ address: payer.address })).toBe(0n);
    expect(await pub.getBalance({ address: refundSigner.address })).toBe(0n);
    expect(svc.getOrder(order.id).txHash).toBe(txHash);
    const metrics = await request({ url: "/v1/metrics", headers: op });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({ paused: false, lowBalance: false, orders: { refunded: 1 } });
    expect(Number(metrics.json().balanceWbt)).toBeGreaterThan(0);
    const finalContext = await request({ url: `/v1/orders/${order.id}/refund-context`, headers: auth });
    expect(finalContext.statusCode).toBe(200);
    expect(finalContext.json()).toMatchObject({ refunded: "25000000", refundIndex: 2, refundBalance: "0" });
    await store.close();
    await app.close();
    db.close();

  }, 90_000);
});
