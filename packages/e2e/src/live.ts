/**
 * Live subset on the real Whitechain testnet (chain 1874), official USDT, qualifying router.
 * Keys come ONLY from the process environment (start with `node --env-file=<gitignored file> ...`). Nothing from the
 * environment is printed; RPC and secrets are redacted by util.redact.
 * Hard caps: 1 payment of at most 2 USDT, at most 10 USDT total.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QUALIFYING_USDT, getQualifyingDeployment, merchantIdFromSlug } from "@quietpay/shared";
import { verifyWebhook } from "@quietpay/merchant-sdk";
import { RelayerProc, WebhookSink, merchantWebhookSecretFor, killAllTracked } from "./procs.js";
import { ERC20, type Stack, type Tenant } from "./stack.js";
import { doRefund, newOrder, payOrder, read } from "./actions.js";
import { runIndexVerify } from "./verify-flow.js";
import { addSecret, explorerTx, log, redact, sleep, waitUntil } from "./util.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing environment variable ${k}`);
  addSecret(v);
  return v;
};
const usdt6 = (n: bigint) => `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")}`;

export async function runLive(o: { evidencePath: string; confirmWrite: boolean }) {
  const lines: string[] = [];
  const ev = (s: string) => { lines.push(s); log(s); };
  const rpc = need("RPC_URL");
  const dep = getQualifyingDeployment();
  const router = dep.router as Address;
  const usdt = QUALIFYING_USDT as Address;
  const payerKey = need("PAYER_PRIVATE_KEY") as Hex;
  const refundKey = need("REFUND_SIGNER_PRIVATE_KEY") as Hex;
  const relayerKey = need("RELAYER_PRIVATE_KEY") as Hex;
  const apiKey = need("MERCHANT_API_KEY");
  const master = need("WEBHOOK_SECRET");
  const operatorToken = need("OPERATOR_TOKEN");
  const payout = need("MERCHANT_PAYOUT_ADDRESS") as Address;
  const chain = { id: 1874, name: "whitechain-sepolia", nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
  const pub = createPublicClient({ chain, transport: http(rpc) });
  if ((await pub.getChainId()) !== 1874) throw new Error("RPC is not chain 1874");

  const payer = privateKeyToAccount(payerKey).address;
  const refundSigner = privateKeyToAccount(refundKey).address;
  const relayerAddr = privateKeyToAccount(relayerKey).address;
  const bal = (a: Address) => pub.readContract({ address: usdt, abi: ERC20, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
  const merchantId = merchantIdFromSlug("demo-store");

  // Preconditions (fail closed, never substitute).
  const before = { payerWbt: await pub.getBalance({ address: payer }), payerUsdt: await bal(payer), signerUsdt: await bal(refundSigner), payoutUsdt: await bal(payout), relayerWbt: await pub.getBalance({ address: relayerAddr }) };
  const gasOneTransfer = ((await pub.getGasPrice()) * 21000n * 3n) / 2n;
  const pending: string[] = [];
  if (before.payerWbt > gasOneTransfer) pending.push(`payer holds ${before.payerWbt} wei WBT, more than one transfer's gas: not gasless`);
  const AMOUNT = 1_000_000n; // 1.000000 USDT, under the 2 USDT cap
  if (before.payerUsdt < AMOUNT) pending.push("payer has less than 1 USDT");
  if (before.signerUsdt < AMOUNT) pending.push("refund signer has less than 1 USDT");
  if (before.relayerWbt < 10n ** 16n) pending.push("relayer has less than 0.01 WBT");
  const isRelayer = (await pub.readContract({ address: router, abi: [{ type: "function", name: "isRelayer", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] }], functionName: "isRelayer", args: [relayerAddr] })) as boolean;
  if (!isRelayer) pending.push("relayer is not allowlisted on the router");

  ev(`# Live evidence (chain 1874, ${new Date().toISOString()})`);
  ev(`Router ${router} (deploy block ${dep.deployBlock}), official USDT ${usdt}.`);
  ev(`Before: payer WBT ${before.payerWbt} wei (one transfer costs about ${gasOneTransfer} wei), payer USDT ${usdt6(before.payerUsdt)}, refund signer USDT ${usdt6(before.signerUsdt)}, payout USDT ${usdt6(before.payoutUsdt)}.`);
  if (pending.length) {
    ev(`\n**pending: unfunded or misconfigured**: ${pending.join("; ")}`);
    if (o.confirmWrite) writeFileSync(o.evidencePath, lines.join("\n") + "\n");
    throw new Error(`live run refused: ${pending.join("; ")}`);
  }

  // Start the real relayer against the real chain, plus a local webhook sink.
  const tmp = mkdtempSync(resolve(tmpdir(), "b-build-w4-live-"));
  const sink = new WebhookSink(Number(process.env.E2E_PORT_BASE ?? 8830) + 3);
  await sink.start();
  const relayer = new RelayerProc({
    port: Number(process.env.E2E_PORT_BASE ?? 8830) + 2, logDir: resolve(tmp, "logs"), name: "relayer-live",
    env: {
      RPC_URL: rpc, CHAIN_ID: "1874", USDT_ADDRESS: usdt, ROUTER_ADDRESS: router, RELAYER_PRIVATE_KEY: relayerKey, OPERATOR_TOKEN: operatorToken,
      MERCHANT_API_KEYS: `${apiKey}:${merchantId}`, WEBHOOK_SECRET: master, ALLOW_PRIVATE_WEBHOOKS: "1", DATABASE_PATH: resolve(tmp, "relayer.db"),
      LOSS_BUDGET_WBT_PER_HOUR: "0.2", RELAY_FEE_USDT: "0.05", EXPLORER_BASE_URL: "https://explorer.testnet.whitechain.io",
    },
  });
  mkdirSync(resolve(tmp, "logs"), { recursive: true });
  const tenant: Tenant = { slug: "demo-store", merchantId, apiKey, payout, refundKey, refundSigner };
  const stack = {
    live: true, chainId: 1874, router, usdt, chainRpc: rpc, pub, tmp, masterSecret: master, operatorToken, relayer, relayerUrl: relayer.url, relayerAddress: relayerAddr, sink, tenant,
    usdtOf: bal, wbtOf: (a: Address) => pub.getBalance({ address: a }), webhookSecretOf: (t: Tenant) => merchantWebhookSecretFor(master, t.merchantId),
    newPayer: async () => { throw new Error("not available live"); }, restartRelayer: async () => { throw new Error("not available live"); }, stop: async () => {},
  } as unknown as Stack;

  const results: string[] = [];
  try {
    await relayer.start();
    const health = await (await fetch(`${relayer.url}/v1/health`)).json() as Record<string, unknown>;
    ev(`Relayer started locally against the testnet (paused: ${String(health.paused)}, relayer ${relayerAddr}).`);

    // 1. Gasless payment through the SDK + relayer.
    const paid = await payOrder(stack, AMOUNT, payerKey, { reference: "live-demo" });
    ev(`\n## 1. Gasless payment (payer signs only; the relayer pays gas)`);
    ev(`Order ${paid.order.id}, amount ${usdt6(AMOUNT)} USDT, fee ${usdt6(BigInt(paid.settled.fee ?? "0"))}. Tx: ${explorerTx(paid.txHash)}`);
    const afterPay = { payerWbt: await pub.getBalance({ address: payer }), payerUsdt: await bal(payer), payoutUsdt: await bal(payout) };
    ev(`Payer WBT unchanged: ${afterPay.payerWbt === before.payerWbt} (${afterPay.payerWbt} wei). Payer USDT ${usdt6(before.payerUsdt)} -> ${usdt6(afterPay.payerUsdt)}. Merchant payout +${usdt6(afterPay.payoutUsdt - before.payoutUsdt)} USDT.`);
    results.push(afterPay.payerWbt === before.payerWbt ? "PASS payer paid no gas" : "FAIL payer WBT changed");

    // 2. Webhook delivery verified with the merchant SDK.
    const hit = await waitUntil(async () => sink.accepted.find((h) => h.body.includes(paid.order.id)), "settled webhook", 60_000, 500);
    const secret = stack.webhookSecretOf(tenant);
    let hookOk = false;
    try { verifyWebhook({ secret, body: hit.body, signatureHeader: hit.sig }); hookOk = true; } catch { hookOk = false; }
    ev(`\n## 2. Webhook\npayment.settled received and signature ${hookOk ? "verified by the merchant SDK" : "FAILED verification"}.`);
    results.push(hookOk ? "PASS webhook verified" : "FAIL webhook");

    // 3. Partial refund, then the remaining amount.
    ev(`\n## 3. Refunds (signed by the merchant's refund signer, submitted gaslessly by the relayer)`);
    const r1 = await doRefund(stack, paid.order.id as Hex, 0, 400_000n);
    ev(`Partial refund 0.400000 USDT: ${r1.txHash ? explorerTx(r1.txHash) : r1.id}`);
    const r2 = await doRefund(stack, paid.order.id as Hex, 1, undefined);
    ev(`Remaining refund (${usdt6(BigInt(r2.amount))} USDT): ${r2.txHash ? explorerTx(r2.txHash) : r2.id}`);
    const final = await read(stack, paid.order.id as Hex);
    ev(`Order after refunds: status ${final.status}, refunded ${final.refundedAmount ?? "?"}.`);
    results.push(BigInt(r1.amount) + BigInt(r2.amount) === AMOUNT ? "PASS refunds sum to the payment" : "FAIL refund total");
    const over = await doRefund(stack, paid.order.id as Hex, 2, 1n).then(() => "accepted", (e: unknown) => String((e as { code?: string }).code ?? (e as Error).message).slice(0, 80));
    ev(`A further refund above the remainder is refused: ${over !== "accepted" ? `yes (${over})` : "NO"}`);
    results.push(over !== "accepted" ? "PASS over-refund refused" : "FAIL over-refund accepted");

    // 4. Re-index and re-verify with the independent verifier (anchored).
    ev(`\n## 4. Ledger export verified against the chain`);
    const head = async () => Number(await pub.getBlockNumber());
    const refundBlock = Number((await pub.getTransactionReceipt({ hash: r2.txHash as Hex })).blockNumber);
    await waitUntil(async () => (await head()) - 12 >= refundBlock, "12 confirmations", 600_000, 3000);
    const v = await runIndexVerify(stack, { from: dep.deployBlock, confirmations: 12, label: "live", rpcUrl: rpc, deployBlock: dep.deployBlock });
    ev(`Rows ${v.rows}, blocks ${v.from}-${v.to}. Verifier exit ${v.okExit} (0 = OK). ${redact(v.checkpoint)}`);
    ev(`A tampered copy (one amount digit changed) fails: exit ${v.tamperExit} (non-zero expected).`);
    results.push(v.okExit === 0 ? "PASS verifier OK" : "FAIL verifier");
    results.push(v.tamperExit !== 0 ? "PASS tampered export rejected" : "FAIL tampered export passed");

    const afterAll = { payerWbt: await pub.getBalance({ address: payer }), payerUsdt: await bal(payer), signerUsdt: await bal(refundSigner) };
    ev(`\nFinal: payer WBT unchanged ${afterAll.payerWbt === before.payerWbt}; payer USDT ${usdt6(afterAll.payerUsdt)}; refund signer USDT ${usdt6(afterAll.signerUsdt)}. Total live payment volume: ${usdt6(AMOUNT)} USDT (cap 10).`);
    ev(`\n## Result\n${results.map((r) => `- ${r}`).join("\n")}`);
  } finally {
    relayer.kill(); sink.stop(); killAllTracked();
    if (o.confirmWrite) writeFileSync(o.evidencePath, redact(lines.join("\n")) + "\n");
  }
  if (results.some((r) => r.startsWith("FAIL"))) throw new Error("live run had failures; see the evidence file");
  await sleep(100);
}
