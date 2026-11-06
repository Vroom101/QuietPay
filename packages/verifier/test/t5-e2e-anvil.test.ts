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
import { makeTamperedSamples } from "../src/tamper.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.CONTRACTS_OUT ?? resolve(here, "../../../contracts/out");
const routerArtifact = resolve(out, "PaymentRouter.sol/PaymentRouter.json");
const tokenArtifact = resolve(out, "MockAuthToken.sol/MockAuthToken.json");
const have = existsSync(routerArtifact) && existsSync(tokenArtifact);

// Well-known anvil dev accounts 0 and 1 (public test keys, local chain only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const PORT = 18647;
const RPC = `http://127.0.0.1:${PORT}`;
const rpc = (method: string, params: unknown[] = []) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());

describe.skipIf(!have)("T5 end to end on anvil: two payments, two partial refunds across a signer rotation", () => {
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

  it("verifies OK anchored, flags each tampered variant with its class, and a from-scratch re-index matches", async () => {
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
    const signerA = privateKeyToAccount(generatePrivateKey());
    const signerB = privateKeyToAccount(generatePrivateKey());
    const payer = privateKeyToAccount(generatePrivateKey());
    const w = wallet(deployer);
    await wait(await w.writeContract({ address: router, abi: paymentRouterAbi, functionName: "registerMerchant", args: [merchantId, payout, signerA.address, 100_000n] }));
    await wait(await w.writeContract({ address: router, abi: paymentRouterAbi, functionName: "setRelayer", args: [relayer.address, true] }));
    for (const to of [payer.address, signerA.address, signerB.address]) {
      await wait(await w.writeContract({ address: usdt, abi: tok.abi, functionName: "mint", args: [to, 100_000_000n] }));
    }

    const now = Number((await pub.getBlock()).timestamp);
    const vA = BigInt(now - 30);
    const vB = BigInt(now + 300);
    const domain = { chainId: 31337, token: usdt, domainName: "Tether USD", domainVersion: "1" };
    const rw = wallet(relayer);
    const pay = async (orderId: Hex, value: bigint, fee: bigint) => {
      const nonce = computePayNonce({ merchantId, orderId, payout, value, fee });
      const sig = await payer.signTypedData(buildCheckoutAuthorization({ from: payer.address, router, value, nonce, validAfter: vA, validBefore: vB, ...domain }));
      await wait(await rw.writeContract({ address: router, abi: paymentRouterAbi, functionName: "pay", args: [merchantId, orderId, payer.address, value, fee, vA, vB, sig] }));
    };
    const refund = async (orderId: Hex, signer: typeof signerA, amount: bigint, index: number) => {
      const nonce = computeRefundNonce({ merchantId, orderId, payer: payer.address, amount, refundIndex: index });
      const sig = await signer.signTypedData(buildRefundAuthorization({ refundSigner: signer.address, router, amount, nonce, validAfter: vA, validBefore: vB, ...domain }));
      await wait(await rw.writeContract({ address: router, abi: paymentRouterAbi, functionName: "refund", args: [merchantId, orderId, amount, vA, vB, sig] }));
    };

    const order1 = ("0x" + "a1".repeat(32)) as Hex;
    const order2 = ("0x" + "b2".repeat(32)) as Hex;
    await pay(order1, 12_000_000n, 50_000n);
    await refund(order1, signerA, 4_000_000n, 0);
    // Rotate the refund signer, then a second partial refund signed by the new signer.
    await wait(await w.writeContract({ address: router, abi: paymentRouterAbi, functionName: "setRefundSigner", args: [merchantId, signerB.address] }));
    await refund(order1, signerB, 2_000_000n, 1);
    await pay(order2, 5_000_000n, 0n);
    await rpc("anvil_mine", ["0x5"]);

    // Export with the indexer, exactly as `pnpm cli export` does.
    const config = { router, usdt, confirmations: 2, deployBlock };
    const db = new IndexerDb(":memory:");
    const res = await indexOnce({ db, src: makeLogSource(RPC), cfg: config });
    const exp = buildExport(db, config, { from: deployBlock, to: res.finalized, generatedAt: "2026-11-06T00:00:00.000Z" });
    db.close();
    expect(exp.meta.hashVersion).toBe(2);
    expect(exp.rows.map((r) => [r.grossUsdt, r.refundedUsdt, r.netUsdt, r.status])).toEqual([
      ["12.000000", "6.000000", "5.950000", "partially_refunded"],
      ["5.000000", "0.000000", "5.000000", "settled"],
    ]);

    // Re-index from scratch into a fresh database: identical rows, identical event-set hash.
    const db2 = new IndexerDb(":memory:");
    const res2 = await indexOnce({ db: db2, src: makeLogSource(RPC), cfg: config });
    const exp2 = buildExport(db2, config, { from: deployBlock, to: res2.finalized, generatedAt: "2026-11-06T00:00:00.000Z" });
    db2.close();
    expect(exp2.csv).toBe(exp.csv);
    expect(exp2.meta.eventSetHash).toBe(exp.meta.eventSetHash);

    const dir = mkdtempSync(join(tmpdir(), "qp-t5-e2e-"));
    const text: string[] = [];
    const deps = { makeSource: makeVerifierSource, stdout: (s: string) => text.push(s), stderr: (s: string) => text.push(s) };
    const anchored = ["--from", String(deployBlock), "--to", String(res.finalized), "--min-confirmations", "2"];
    const verify = async (name: string, csv: string, meta: string, extra: string[] = anchored) => {
      const csvPath = join(dir, `${name}.csv`);
      writeFileSync(csvPath, csv);
      writeFileSync(`${csvPath}.meta.json`, meta);
      text.length = 0;
      const code = await runCli(["verify", "--csv", csvPath, "--rpc", RPC, "--router", router, "--usdt", usdt, "--no-payto", ...extra], deps);
      return { code, report: JSON.parse(readFileSync(`${csvPath}.verify.json`, "utf8")) as { ok: boolean; anchored: boolean; issues: { code: string }[] }, text: text.join("\n") };
    };
    const metaText = JSON.stringify(exp.meta, null, 2) + "\n";

    // Clean export passes, anchored.
    const ok = await verify("clean", exp.csv, metaText);
    expect(ok.code).toBe(0);
    expect(ok.report.ok).toBe(true);
    expect(ok.report.anchored).toBe(true);
    expect(ok.text).not.toMatch(/unanchored/);

    // Without the outside range it still passes, but says so.
    const loose = await verify("loose", exp.csv, metaText, []);
    expect(loose.code).toBe(0);
    expect(loose.text).toMatch(/unanchored/);

    // Every tampered variant fails with its class.
    for (const s of makeTamperedSamples(exp.csv, metaText)) {
      const r = await verify(s.name, s.csv, s.meta, s.verifierArgs.length ? anchored : []);
      expect(r.code, s.name).toBe(1);
      expect(r.report.issues.map((i) => i.code), s.name).toContain(s.expect);
    }

    // An export from before hashVersion 2 is reported as unsupported, not as tampered.
    const { hashVersion: _drop, ...legacy } = JSON.parse(metaText);
    const old = await verify("legacy", exp.csv, JSON.stringify(legacy));
    expect(old.code).toBe(1);
    expect(old.report.issues.map((i) => i.code)).toEqual(["unsupported_hash_version"]);

    // Forgetting to say --payto/--no-payto is refused, never silently OK.
    const csvPath = join(dir, "clean.csv");
    text.length = 0;
    expect(await runCli(["verify", "--csv", csvPath, "--rpc", RPC, "--router", router, "--usdt", usdt], deps)).toBe(2);
  }, 120_000);
});
