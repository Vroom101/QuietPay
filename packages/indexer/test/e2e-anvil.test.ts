import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildCheckoutAuthorization,
  buildRefundAuthorization,
  computePayNonce,
  computeRefundNonce,
  merchantIdFromSlug,
  paymentRouterAbi,
} from "@quietpay/shared";
import { IndexerDb, buildExport, indexOnce, makeLogSource, rebuild } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.CONTRACTS_OUT ?? resolve(here, "../../../contracts/out");
const routerArtifact = resolve(out, "PaymentRouter.sol/PaymentRouter.json");
const tokenArtifact = resolve(out, "MockAuthToken.sol/MockAuthToken.json");
const have = existsSync(routerArtifact) && existsSync(tokenArtifact);

const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const PORT = 18645;
const RPC = `http://127.0.0.1:${PORT}`;
const rpc = (method: string, params: unknown[] = []) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());

describe.skipIf(!have)("13. end to end on anvil with the real router", () => {
  let anvil: ChildProcess;
  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await rpc("eth_chainId")).result) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 30_000);
  afterAll(() => anvil?.kill());

  it("indexes a payment, a refund and an agent transfer, and exports the expected CSV", async () => {
    const deployer = privateKeyToAccount(DEPLOYER_KEY);
    const relayer = privateKeyToAccount(RELAYER_KEY);
    const chainDef = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
    const pub = createPublicClient({ chain: chainDef, transport: http(RPC) });
    const wallet = (a: typeof deployer) => createWalletClient({ account: a, chain: chainDef, transport: http(RPC) });
    const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash });
    const load = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const tok = load(tokenArtifact);
    const rt = load(routerArtifact);

    const usdt = (await wait(await wallet(deployer).deployContract({ abi: tok.abi, bytecode: tok.bytecode.object }))).contractAddress!;
    const routerRcpt = await wait(await wallet(deployer).deployContract({ abi: rt.abi, bytecode: rt.bytecode.object, args: [usdt, deployer.address] }));
    const router = routerRcpt.contractAddress!;
    const deployBlock = Number(routerRcpt.blockNumber);

    const merchantId = merchantIdFromSlug("demo-store");
    const facilitator = privateKeyToAccount(generatePrivateKey()).address; // also the merchant payout: the double-count case
    const refundKey = generatePrivateKey();
    const refundSigner = privateKeyToAccount(refundKey);
    const payerKey = generatePrivateKey();
    const payer = privateKeyToAccount(payerKey);
    const w = wallet(deployer);
    await wait(await w.writeContract({ address: router, abi: paymentRouterAbi, functionName: "registerMerchant", args: [merchantId, facilitator, refundSigner.address, 100_000n] }));
    await wait(await w.writeContract({ address: router, abi: paymentRouterAbi, functionName: "setRelayer", args: [relayer.address, true] }));
    for (const to of [payer.address, refundSigner.address]) {
      await wait(await w.writeContract({ address: usdt, abi: tok.abi, functionName: "mint", args: [to, 100_000_000n] }));
    }

    const block = async () => Number((await pub.getBlock()).timestamp);
    const sign = async (acct: typeof payer, td: ReturnType<typeof buildCheckoutAuthorization>) => acct.signTypedData(td);
    const domain = { chainId: 31337, token: usdt, domainName: "Tether USD", domainVersion: "1" };

    // 1. A router payment of 25.00 with a 0.05 fee. The payout equals the facilitator address.
    const orderId = ("0x" + "ab".repeat(32)) as Hex;
    let now = await block();
    const vA = BigInt(now - 30);
    const vB = BigInt(now + 300);
    const payNonce = computePayNonce({ merchantId, orderId, payout: facilitator, value: 25_000_000n, fee: 50_000n });
    const paySig = await sign(payer, buildCheckoutAuthorization({ from: payer.address, router, value: 25_000_000n, nonce: payNonce, validAfter: vA, validBefore: vB, ...domain }));
    const rw = wallet(relayer);
    const payRcpt = await wait(await rw.writeContract({ address: router, abi: paymentRouterAbi, functionName: "pay", args: [merchantId, orderId, payer.address, 25_000_000n, 50_000n, vA, vB, paySig] }));

    // 2. A partial refund of 10.00.
    const rIdx = 0;
    const rNonce = computeRefundNonce({ merchantId, orderId, payer: payer.address, amount: 10_000_000n, refundIndex: rIdx });
    const rSig = await refundSigner.signTypedData(buildRefundAuthorization({ refundSigner: refundSigner.address, router, amount: 10_000_000n, nonce: rNonce, validAfter: vA, validBefore: vB, ...domain }));
    await wait(await rw.writeContract({ address: router, abi: paymentRouterAbi, functionName: "refund", args: [merchantId, orderId, 10_000_000n, vA, vB, rSig] }));

    // 3. A bare USDT transfer (recorded as payto_transfer, not x402 proof) of 1.50 from the payer to the facilitator. The payer needs gas for a plain transfer.
    await wait(await w.sendTransaction({ to: payer.address, value: 10n ** 18n }));
    await wait(await wallet(payer).writeContract({ address: usdt, abi: tok.abi, functionName: "transfer", args: [facilitator, 1_500_000n] }));

    // Finalize: mine past the confirmation depth.
    await rpc("anvil_mine", ["0x5"]);

    const config = { router, usdt, facilitatorPayTo: facilitator, confirmations: 2, deployBlock };
    const db = new IndexerDb(":memory:");
    const res = await indexOnce({ db, src: makeLogSource(RPC), cfg: config });
    expect(res.newEvents).toBeGreaterThanOrEqual(5); // RelayerSet, MerchantRegistered, Paid, Refunded, Transfer

    const exp = buildExport(db, config, { from: deployBlock, to: res.finalized, generatedAt: "2026-11-06T00:00:00.000Z" });
    const rows = exp.rows;
    expect(rows).toHaveLength(2); // the payout transfer to the facilitator is NOT counted a second time

    const [routerRow, paytoRow] = rows;
    expect(routerRow).toMatchObject({
      source: "router",
      orderId,
      merchantId,
      payer: payer.address.toLowerCase(),
      grossUsdt: "25.000000",
      relayFeeUsdt: "0.050000",
      refundedUsdt: "10.000000",
      netUsdt: "14.950000",
      status: "partially_refunded",
      txHash: payRcpt.transactionHash,
    });
    expect(paytoRow).toMatchObject({ source: "payto_transfer", orderId: "", merchantId: "", payer: payer.address.toLowerCase(), grossUsdt: "1.500000", netUsdt: "1.500000", status: "settled" });

    const lines = exp.csv.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]!.split(",").slice(1, 10)).toEqual(["router", orderId, merchantId, payer.address.toLowerCase(), "25.000000", "0.050000", "10.000000", "14.950000", "partially_refunded"]);
    expect(lines[2]!.split(",").slice(1, 10)).toEqual(["payto_transfer", "", "", payer.address.toLowerCase(), "1.500000", "0.000000", "0.000000", "1.500000", "settled"]);

    // Idempotent re-run, rebuild parity, and a byte-identical second export.
    expect((await indexOnce({ db, src: makeLogSource(RPC), cfg: config })).newEvents).toBe(0);
    const before = db.ledger();
    rebuild(db, config);
    expect(db.ledger()).toEqual(before);
    expect(buildExport(db, config, { from: deployBlock, to: res.finalized, generatedAt: "2026-11-06T00:00:00.000Z" }).csv).toBe(exp.csv);
  }, 90_000);
});
