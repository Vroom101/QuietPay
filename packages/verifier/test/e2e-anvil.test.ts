import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { IndexerDb, buildExport, indexOnce, makeLogSource } from "@quietpay/indexer";
import { makeVerifierSource, runCli } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.CONTRACTS_OUT ?? resolve(here, "../../../contracts/out");
const routerArtifact = resolve(out, "PaymentRouter.sol/PaymentRouter.json");
const tokenArtifact = resolve(out, "MockAuthToken.sol/MockAuthToken.json");
const have = existsSync(routerArtifact) && existsSync(tokenArtifact);

// Well-known anvil dev accounts 0 and 1 (public test keys, local chain only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const PORT = 18646;
const RPC = `http://127.0.0.1:${PORT}`;
const rpc = (method: string, params: unknown[] = []) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());

describe.skipIf(!have)("end to end on anvil: real payment + partial refund, indexer export, independent verify", () => {
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

  it("verifies the indexer's export OK, then FAILS after one amount is edited", async () => {
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
    const payout = privateKeyToAccount(generatePrivateKey()).address;
    const facilitator = privateKeyToAccount(generatePrivateKey()).address;
    const refundSigner = privateKeyToAccount(generatePrivateKey());
    const payer = privateKeyToAccount(generatePrivateKey());
    const w = wallet(deployer);
    await wait(await w.writeContract({ address: router, abi: paymentRouterAbi, functionName: "registerMerchant", args: [merchantId, payout, refundSigner.address, 100_000n] }));
    await wait(await w.writeContract({ address: router, abi: paymentRouterAbi, functionName: "setRelayer", args: [relayer.address, true] }));
    for (const to of [payer.address, refundSigner.address]) {
      await wait(await w.writeContract({ address: usdt, abi: tok.abi, functionName: "mint", args: [to, 100_000_000n] }));
    }

    const now = Number((await pub.getBlock()).timestamp);
    const vA = BigInt(now - 30);
    const vB = BigInt(now + 300);
    const domain = { chainId: 31337, token: usdt, domainName: "Tether USD", domainVersion: "1" };
    const orderId = ("0x" + "cd".repeat(32)) as Hex;
    const rw = wallet(relayer);

    // A real payment of 12.00 with a 0.05 relay fee, then a real partial refund of 4.00.
    const payNonce = computePayNonce({ merchantId, orderId, payout, value: 12_000_000n, fee: 50_000n });
    const paySig = await payer.signTypedData(buildCheckoutAuthorization({ from: payer.address, router, value: 12_000_000n, nonce: payNonce, validAfter: vA, validBefore: vB, ...domain }));
    await wait(await rw.writeContract({ address: router, abi: paymentRouterAbi, functionName: "pay", args: [merchantId, orderId, payer.address, 12_000_000n, 50_000n, vA, vB, paySig] }));
    const rNonce = computeRefundNonce({ merchantId, orderId, payer: payer.address, amount: 4_000_000n, refundIndex: 0 });
    const rSig = await refundSigner.signTypedData(buildRefundAuthorization({ refundSigner: refundSigner.address, router, amount: 4_000_000n, nonce: rNonce, validAfter: vA, validBefore: vB, ...domain }));
    await wait(await rw.writeContract({ address: router, abi: paymentRouterAbi, functionName: "refund", args: [merchantId, orderId, 4_000_000n, vA, vB, rSig] }));
    // A bare deposit to the facilitator pay-to address.
    await wait(await w.sendTransaction({ to: payer.address, value: 10n ** 18n }));
    await wait(await wallet(payer).writeContract({ address: usdt, abi: tok.abi, functionName: "transfer", args: [facilitator, 2_000_000n] }));
    await rpc("anvil_mine", ["0x5"]);

    // Export with the indexer, exactly as `pnpm cli export` does.
    const config = { router, usdt, facilitatorPayTo: facilitator, confirmations: 2, deployBlock };
    const db = new IndexerDb(":memory:");
    const res = await indexOnce({ db, src: makeLogSource(RPC), cfg: config });
    const exp = buildExport(db, config, { from: deployBlock, to: res.finalized, generatedAt: "2026-11-06T00:00:00.000Z" });
    db.close();
    expect(exp.rows.map((r) => [r.source, r.grossUsdt, r.refundedUsdt, r.netUsdt, r.status])).toEqual([
      ["router", "12.000000", "4.000000", "7.950000", "partially_refunded"],
      ["payto_transfer", "2.000000", "0.000000", "2.000000", "settled"],
    ]);

    const dir = mkdtempSync(join(tmpdir(), "qp-verifier-e2e-"));
    const csvPath = join(dir, "ledger.csv");
    writeFileSync(csvPath, exp.csv);
    writeFileSync(`${csvPath}.meta.json`, JSON.stringify(exp.meta, null, 2) + "\n");
    const argv = ["verify", "--csv", csvPath, "--rpc", RPC, "--router", router, "--usdt", usdt, "--payto", facilitator];
    const outText: string[] = [];
    const deps = { makeSource: makeVerifierSource, stdout: (s: string) => outText.push(s), stderr: (s: string) => outText.push(s) };

    expect(await runCli(argv, deps)).toBe(0);
    const okReport = JSON.parse(readFileSync(`${csvPath}.verify.json`, "utf8"));
    expect(okReport.ok).toBe(true);
    expect(okReport.chainId).toBe(31337);
    expect(okReport.checks.invariants).toBe("pass");

    // Edit one amount: the net of the router row.
    writeFileSync(csvPath, exp.csv.replace(",7.950000,", ",8.950000,"));
    outText.length = 0;
    expect(await runCli(argv, deps)).toBe(1);
    const bad = JSON.parse(readFileSync(`${csvPath}.verify.json`, "utf8"));
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((i: { code: string }) => i.code)).toContain("wrong_amount");
    expect(bad.issues.find((i: { code: string }) => i.code === "wrong_amount").field).toBe("net_usdt");
    expect(outText.join("\n")).toMatch(/RESULT: FAIL/);
  }, 90_000);
});
