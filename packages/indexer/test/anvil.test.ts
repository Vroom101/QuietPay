import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, unlink, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  type Hex,
  type Abi,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  paymentRouterAbi,
  buildCheckoutAuthorization,
  computePayNonce,
  buildRefundAuthorization,
} from "@quietpay/shared";
import { IndexDb } from "../src/db.js";
import { Indexer } from "../src/indexer.js";
import { makeReader } from "../src/chain.js";
import { verifyExport } from "../src/verifier.js";
import { readCsv, writeCsv } from "../src/csv.js";
import { buildServer } from "../src/server.js";
import type { Scope } from "../src/model.js";

const here = dirname(fileURLToPath(import.meta.url)),
  root = resolve(here, "../../.."),
  rpc = "http://127.0.0.1:19545";
const artifacts = process.env.CONTRACTS_OUT ?? join(root, "contracts/out");
const anvilBin = process.env.ANVIL_BIN ?? "anvil";
const ready =
  existsSync(join(artifacts, "PaymentRouter.sol/PaymentRouter.json")) &&
  spawnSync(anvilBin, ["--version"], { stdio: "ignore" }).status === 0;
if (process.env.CI && !ready)
  throw new Error("Indexer integration needs Foundry artifacts and Anvil");
const exec = promisify(execFile);

describe.skipIf(!ready)("Anvil accounting, verifier, HTTP and CLI", () => {
  let anvil: ReturnType<typeof spawn>;
  beforeAll(async () => {
    anvil = spawn(anvilBin, ["--port", "19545", "--silent"], {
      stdio: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try {
        if (
          (
            await fetch(rpc, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
            })
          ).ok
        )
          return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Anvil failed to start");
  }, 20000);
  afterAll(() => {
    anvil?.kill();
  });
  it("rebuilds payments/refunds and agent transfers, detects tampering and recovers a real reorg", async () => {
    const chain = {
      id: 31337,
      name: "Anvil",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    } as const;
    const owner = privateKeyToAccount(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    const relayer = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const payer = privateKeyToAccount(generatePrivateKey()),
      refundSigner = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({
        account: owner,
        chain,
        transport: http(rpc),
      }),
      relay = createWalletClient({
        account: relayer,
        chain,
        transport: http(rpc),
      });
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const artifact = (name: string) =>
      JSON.parse(
        readFileSync(join(artifacts, `${name}.sol/${name}.json`), "utf8"),
      ) as { abi: Abi; bytecode: { object: Hex } };
    const tokenArtifact = artifact("MockUSDT"),
      routerArtifact = artifact("PaymentRouter");
    const token = (
      await pub.waitForTransactionReceipt({
        hash: await wallet.deployContract({
          abi: tokenArtifact.abi,
          bytecode: tokenArtifact.bytecode.object,
        }),
      })
    ).contractAddress!;
    const deployed = await pub.waitForTransactionReceipt({
      hash: await wallet.deployContract({
        abi: routerArtifact.abi,
        bytecode: routerArtifact.bytecode.object,
        args: [token, owner.address],
      }),
    });
    const router = deployed.contractAddress!,
      merchant = keccak256(stringToHex("ledger-shop")),
      order = keccak256(stringToHex("ledger-order")),
      agentMerchant = keccak256(stringToHex("agent-api"));
    const payout = "0x2222222222222222222222222222222222222222" as Hex;
    const transact = async (args: Parameters<typeof wallet.writeContract>[0]) =>
      pub.waitForTransactionReceipt({ hash: await wallet.writeContract(args) });
    await transact({
      address: router,
      abi: paymentRouterAbi,
      functionName: "registerMerchant",
      args: [merchant, payout, refundSigner.address, 100000n],
    });
    await transact({
      address: router,
      abi: paymentRouterAbi,
      functionName: "setRelayer",
      args: [relayer.address, true],
    });
    for (const [recipient, amount] of [
      [payer.address, 100000000n],
      [refundSigner.address, 25000000n],
      [owner.address, 1000000n],
    ] as const)
      await transact({
        address: token,
        abi: tokenArtifact.abi,
        functionName: "mint",
        args: [recipient, amount],
      });
    const now = Number((await pub.getBlock()).timestamp),
      validAfter = BigInt(now - 5),
      validBefore = BigInt(now + 300);
    const signature = await payer.signTypedData(
      buildCheckoutAuthorization({
        from: payer.address,
        router,
        token,
        chainId: 31337,
        value: 25000000n,
        nonce: computePayNonce({
          merchantId: merchant,
          orderId: order,
          payout,
          value: 25000000n,
        }),
        validAfter,
        validBefore,
      }),
    );
    const paid = await pub.waitForTransactionReceipt({
      hash: await relay.writeContract({
        address: router,
        abi: paymentRouterAbi,
        functionName: "pay",
        args: [
          merchant,
          order,
          payer.address,
          25000000n,
          50000n,
          validAfter,
          validBefore,
          signature,
        ],
      }),
    });
    await transact({
      address: token,
      abi: tokenArtifact.abi,
      functionName: "transfer",
      args: [payout, 1000000n],
    });
    const rpcCall = async (method: string, params: unknown[] = []) => {
      const response = (await (
        await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json()) as { result: unknown; error?: unknown };
      if (response.error) throw new Error(JSON.stringify(response.error));
      return response.result;
    };
    const mine = async (n = 2) => {
      for (let i = 0; i < n; i++) await rpcCall("evm_mine");
    };
    await mine();
    const scope: Scope = {
      chainId: 31337,
      router,
      token,
      deploymentBlock: Number(deployed.blockNumber),
      confirmations: 2,
      agent: { payTo: payout, merchantId: agentMerchant },
    };
    const db = new IndexDb(":memory:", scope),
      indexer = new Indexer(db, makeReader(rpc, scope), scope, 2);
    const app = buildServer(
      indexer,
      new Map([
        ["shop", merchant],
        ["agent", agentMerchant],
      ]),
    );
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const temp = await mkdtemp(join(tmpdir(), "quietpay-indexer-"));
    try {
      await indexer.sync();
      const baseline = await indexer.export();
      expect(readCsv(baseline.csv)).toHaveLength(2); // Router's token payout was not double-counted as an agent payment.
      expect(
        readCsv(baseline.csv).filter((r) => r.source === "x402"),
      ).toHaveLength(1);
      const snapshot = await rpcCall("evm_snapshot");
      const refund = async (amount: bigint, index: bigint) => {
        const signature = await refundSigner.signTypedData(
          buildRefundAuthorization({
            merchantId: merchant,
            orderId: order,
            payer: payer.address,
            refundSigner: refundSigner.address,
            router,
            token,
            chainId: 31337,
            amount,
            refundIndex: index,
            validAfter,
            validBefore,
          }),
        );
        const receipt = await pub.waitForTransactionReceipt({
          hash: await relay.writeContract({
            address: router,
            abi: paymentRouterAbi,
            functionName: "refund",
            args: [merchant, order, amount, validAfter, validBefore, signature],
          }),
        });
        await mine();
        return receipt;
      };
      const partial = await refund(5000000n, 0n);
      await indexer.sync();
      const bundle = await indexer.export();
      expect(readCsv(bundle.csv)).toHaveLength(3);
      const result = await verifyExport(makeReader(rpc, scope), scope, bundle);
      expect(result.ok).toBe(true);
      const onlyRefund = await indexer.export({
        fromBlock: Number(partial.blockNumber),
        toBlock: Number(partial.blockNumber),
        merchantId: merchant,
      });
      expect(
        (await verifyExport(makeReader(rpc, scope), scope, onlyRefund)).counts
          .matched,
      ).toBe(1);
      const rows = readCsv(bundle.csv);
      rows[0]!.gross_usdt = "99.000000";
      expect(
        (
          await verifyExport(makeReader(rpc, scope), scope, {
            ...bundle,
            csv: writeCsv(rows),
          })
        ).counts.altered,
      ).toBe(1);
      expect(
        (
          await verifyExport(makeReader(rpc, scope), scope, {
            ...bundle,
            csv: writeCsv(readCsv(bundle.csv).slice(1)),
          })
        ).counts.missing,
      ).toBe(1);
      const headers = { authorization: "Bearer shop" };
      expect((await fetch(`${baseUrl}/v1/ledger`)).status).toBe(401);
      const ledger = await (
        await fetch(`${baseUrl}/v1/ledger`, { headers })
      ).json();
      expect(ledger.totals).toMatchObject({
        gross: "25.000000",
        refunded: "5.000000",
        net: "19.950000",
      });
      const scoped = await (
        await fetch(`${baseUrl}/v1/ledger/export`, { headers })
      ).json();
      expect(readCsv(scoped.csv)).toHaveLength(2);
      const verified = await fetch(`${baseUrl}/v1/ledger/verify`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(scoped),
      });
      expect(verified.status).toBe(200);
      expect((await verified.json()).ok).toBe(true);
      expect(
        (
          await fetch(`${baseUrl}/v1/ledger/verify`, {
            method: "POST",
            headers: {
              authorization: "Bearer agent",
              "content-type": "application/json",
            },
            body: JSON.stringify(scoped),
          })
        ).status,
      ).toBe(403);
      await refund(20000000n, 1n);
      expect((await indexer.ledger(merchant)).orders[0]).toMatchObject({
        status: "refunded",
        refunded: "25.000000",
        net: "-0.050000",
      });
      const beforeReorg = await indexer.export();
      await rpcCall("evm_revert", [snapshot]);
      await transact({
        address: router,
        abi: paymentRouterAbi,
        functionName: "setPayout",
        args: [merchant, owner.address],
      });
      await mine(7);
      await indexer.sync();
      expect((await indexer.ledger(merchant)).orders[0]).toMatchObject({
        status: "paid",
        refunded: "0.000000",
        net: "24.950000",
      });
      expect(
        (await verifyExport(makeReader(rpc, scope), scope, beforeReorg)).ok,
      ).toBe(false);
      const freshDb = new IndexDb(":memory:", scope),
        fresh = new Indexer(freshDb, makeReader(rpc, scope), scope, 3);
      const rebuilt = await fresh.export(),
        current = await indexer.export();
      expect(rebuilt.csv).toBe(current.csv);
      expect(rebuilt.meta.eventSetHash).toBe(current.meta.eventSetHash);
      freshDb.close();
      const env = {
        ...process.env,
        RPC_URL: rpc,
        CHAIN_ID: "31337",
        ROUTER_ADDRESS: router,
        USDT_ADDRESS: token,
        INDEXER_FROM_BLOCK: String(scope.deploymentBlock),
        INDEXER_CONFIRMATIONS: "2",
        FACILITATOR_PAYTO: payout,
        FACILITATOR_MERCHANT_ID: agentMerchant,
        INDEXER_DATABASE_PATH: join(temp, "ledger.db"),
        MERCHANT_API_KEYS: `shop:${merchant}`,
      };
      const cli = (args: string[], customEnv = env) =>
        exec(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
          cwd: resolve(here, ".."),
          env: customEnv,
          maxBuffer: 2 * 1024 * 1024,
        });
      await cli(["sync"]);
      await cli(["export", "--out", join(temp, "export")]);
      const independent = {
        ...env,
        INDEXER_DATABASE_PATH: join(temp, "must-not-be-opened.db"),
      };
      const cliResult = await cli(
        [
          "verify",
          "--csv",
          join(temp, "export.csv"),
          "--meta",
          join(temp, "export.meta.json"),
        ],
        independent,
      );
      expect(JSON.parse(cliResult.stdout).ok).toBe(true);
      expect(existsSync(independent.INDEXER_DATABASE_PATH)).toBe(false);
      await writeFile(
        join(temp, "bad.csv"),
        readFileSync(join(temp, "export.csv"), "utf8").replace(
          "25.000000",
          "26.000000",
        ),
      );
      try {
        await cli(
          [
            "verify",
            "--csv",
            join(temp, "bad.csv"),
            "--meta",
            join(temp, "export.meta.json"),
          ],
          independent,
        );
        expect.fail("Tampered export should fail");
      } catch (e) {
        const error = e as { code: number; stdout: string };
        expect(error.code).toBe(1);
        expect(JSON.parse(error.stdout).counts.altered).toBe(1);
      }
      expect(await pub.getBalance({ address: payer.address })).toBe(0n);
      expect(Number(paid.blockNumber)).toBeGreaterThan(scope.deploymentBlock);
    } finally {
      await app.close();
      db.close();
      for (const file of await readdir(temp)) await unlink(join(temp, file));
      await rmdir(temp);
    }
  }, 90000);
});
