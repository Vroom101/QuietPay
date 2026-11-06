import { createAgent } from "@quietpay/agent-client";
import { runDemo } from "@quietpay/agent-demo";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Db,
  RelayerService,
  makeChain,
  buildServer,
  preflight,
} from "@quietpay/relayer/core";
import {
  paymentRouterAbi,
  makePaidPolicies,
  encodeX402Header,
  decodeX402Header,
  X402Required,
  X402SettleResponse,
  buildAgentAuthorization,
  buildCheckoutAuthorization,
  type X402Payload,
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
} from "@quietpay/shared";
import {
  IndexDb,
  Indexer,
  makeReader,
  verifyExport,
  readCsv,
} from "@quietpay/indexer";
import { makeCfg } from "../../relayer/test/helpers.js";
import { FacilitatorService } from "../src/service.js";
import { registerFacilitator } from "../src/server.js";
import { buildPaidApi } from "../../../apps/paid-api/src/app.js";
const here = dirname(fileURLToPath(import.meta.url)),
  out = process.env.CONTRACTS_OUT ?? resolve(here, "../../../contracts/out");
const anvilBin = process.env.ANVIL_BIN ?? "anvil",
  rpc = "http://127.0.0.1:20545";
const ready =
  existsSync(join(out, "PaymentRouter.sol/PaymentRouter.json")) &&
  spawnSync(anvilBin, ["--version"], { stdio: "ignore" }).status === 0;
if (process.env.CI && !ready)
  throw new Error("x402 integration requires compiled contracts and Anvil");
const pause = () => new Promise((r) => setTimeout(r, 25));
describe.skipIf(!ready)(
  "real x402 payment path and shared checkout wallet",
  () => {
    let anvil: ReturnType<typeof spawn>;
    beforeAll(async () => {
      anvil = spawn(anvilBin, ["--port", "20545", "--silent"], {
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
        await pause();
      }
      throw new Error("Anvil failed to start");
    }, 20000);
    afterAll(() => anvil?.kill());
    it("settles paid HTTP calls, prevents replay, shares nonce/gas accounting and verifies agent ledger entries", async () => {
      const chain = {
        id: 31337,
        name: "Anvil",
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
      } as const;
      const owner = privateKeyToAccount(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      );
      const relayerKey =
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
      const payer = privateKeyToAccount(generatePrivateKey()),
        wallet = createWalletClient({
          chain,
          account: owner,
          transport: http(rpc),
        }),
        pub = createPublicClient({ chain, transport: http(rpc) });
      const artifact = (name: string) =>
        JSON.parse(
          readFileSync(join(out, `${name}.sol/${name}.json`), "utf8"),
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
      const deployment = await pub.waitForTransactionReceipt({
        hash: await wallet.deployContract({
          abi: routerArtifact.abi,
          bytecode: routerArtifact.bytecode.object,
          args: [token, owner.address],
        }),
      });
      const router = deployment.contractAddress!,
        merchant = keccak256(stringToHex("x402-demo")),
        payout = "0x2222222222222222222222222222222222222222" as Hex,
        payTo = "0x3333333333333333333333333333333333333333" as Hex;
      await pub.waitForTransactionReceipt({
        hash: await wallet.writeContract({
          address: router,
          abi: paymentRouterAbi,
          functionName: "registerMerchant",
          args: [merchant, payout, owner.address, 100000n],
        }),
      });
      await pub.waitForTransactionReceipt({
        hash: await wallet.writeContract({
          address: router,
          abi: paymentRouterAbi,
          functionName: "setRelayer",
          args: [privateKeyToAccount(relayerKey).address, true],
        }),
      });
      await pub.waitForTransactionReceipt({
        hash: await wallet.writeContract({
          address: token,
          abi: tokenArtifact.abi,
          functionName: "mint",
          args: [payer.address, 100000000n],
        }),
      });
      const cfg = makeCfg({
        rpcUrl: rpc,
        chainId: 31337,
        usdt: token,
        router,
        relayerKey,
        apiKeys: new Map([["test-key", merchant]]),
        lossBudgetWei: 10n ** 18n,
      });
      expect((await preflight(cfg)).ok).toBe(true);
      const db = new Db(":memory:"),
        svc = new RelayerService({
          cfg,
          db,
          chain: makeChain({
            rpcUrl: rpc,
            chainId: 31337,
            router,
            relayerKey,
            nonceFloor: () => db.nonceFloor(),
          }),
        });
      const apiUrl = "http://127.0.0.1:20547",
        policies = makePaidPolicies({
          baseUrl: apiUrl,
          merchantId: merchant,
          payTo,
          asset: token,
          chainId: 31337,
          name: "Tether USD",
          version: "1",
        });
      const facilitator = new FacilitatorService(svc, {
          policies,
          settlementWaitMs: 8000,
        }),
        app = buildServer(svc);
      await registerFacilitator(app, facilitator);
      const facilitatorUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      const api = buildPaidApi({
        policies,
        facilitatorUrl,
        apiKey: "test-key",
      });
      await api.listen({ host: "127.0.0.1", port: 20547 });
      const rpcCall = async (method: string, params: unknown[] = []) => {
        const body = await (
          await fetch(rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
        ).json();
        if (body.error) throw new Error(JSON.stringify(body.error));
        return body.result;
      };
      const signed = async (path: string, n: number): Promise<X402Payload> => {
        const challenge = await fetch(apiUrl + path);
        expect(challenge.status).toBe(402);
        const required = decodeX402Header(
            challenge.headers.get(PAYMENT_REQUIRED)!,
            X402Required,
          ),
          accepted = required.accepts[0]!;
        // Match the client's wall clock: rapid Anvil blocks may run ahead of wall time,
        // while the facilitator enforces maxTimeoutSeconds against its own clock.
        const now = Math.floor(Date.now() / 1000),
          nonce = ("0x" + n.toString(16).padStart(64, "0")) as Hex;
        const a = {
          from: payer.address,
          to: accepted.payTo,
          value: accepted.amount,
          validAfter: "0",
          validBefore: String(now + 55),
          nonce,
        };
        const signature = await payer.signTypedData(
          buildAgentAuthorization({
            from: payer.address,
            to: a.to as Hex,
            value: BigInt(a.value),
            validAfter: 0n,
            validBefore: BigInt(a.validBefore),
            nonce,
            chainId: 31337,
            token,
          }),
        );
        return {
          x402Version: 2,
          resource: required.resource,
          accepted,
          payload: { signature, authorization: a },
        };
      };
      const minePayment = async (payload: X402Payload) => {
        for (let i = 0; i < 300; i++) {
          const row = db.raw
            .prepare(
              "SELECT tx_hash FROM x402_payments WHERE payer=? AND nonce=?",
            )
            .get(
              payer.address.toLowerCase(),
              payload.payload.authorization.nonce,
            ) as { tx_hash: string | null } | undefined;
          if (row?.tx_hash) {
            try {
              await pub.getTransactionReceipt({ hash: row.tx_hash as Hex });
              await rpcCall("evm_mine");
              return row.tx_hash;
            } catch {}
          }
          await pause();
        }
        throw new Error(`Agent transaction did not arrive; rejections: ${JSON.stringify(svc.metrics().rejected)}`);
      };
      const headers = (payload: X402Payload) => ({
        "PAYMENT-SIGNATURE": encodeX402Header(payload),
      });
      try {
        const supported = await (
          await fetch(facilitatorUrl + "/supported")
        ).json();
        expect(supported.kinds[0].network).toBe("eip155:31337");
        const first = await signed("/v1/quote", 1),
          responsePromise = fetch(apiUrl + "/v1/quote", {
            headers: headers(first),
          });
        const firstHash = await minePayment(first),
          response = await responsePromise;
        expect(response.status).toBe(200);
        expect((await response.json()).demo).toBe(true);
        expect(
          decodeX402Header(
            response.headers.get(PAYMENT_RESPONSE)!,
            X402SettleResponse,
          ),
        ).toMatchObject({
          success: true,
          transaction: firstHash,
          network: "eip155:31337",
        });
        expect(
          (await fetch(apiUrl + "/v1/quote", { headers: headers(first) }))
            .status,
        ).toBe(402);
        const second = await signed("/v1/quote", 2),
          parallel = [
            fetch(apiUrl + "/v1/quote", { headers: headers(second) }),
            fetch(apiUrl + "/v1/quote", { headers: headers(second) }),
          ];
        await minePayment(second);
        const results = await Promise.all(parallel);
        expect(results.map((r) => r.status).sort()).toEqual([200, 402]);
        await Promise.all(results.map((r) => r.text()));
        const created = await (
          await fetch(facilitatorUrl + "/v1/orders", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer test-key",
            },
            body: JSON.stringify({ merchantId: merchant, amount: "1000000" }),
          })
        ).json();
        const now = Math.floor(Date.now() / 1000),
          validAfter = now - 5,
          validBefore = now + 300;
        const paySignature = await payer.signTypedData(
          buildCheckoutAuthorization({
            from: payer.address,
            router,
            value: 1000000n,
            nonce: created.checkout.nonce,
            validAfter: BigInt(validAfter),
            validBefore: BigInt(validBefore),
            chainId: 31337,
            token,
          }),
        );
        const third = await signed("/v1/signal", 3),
          agentPromise = fetch(apiUrl + "/v1/signal", {
            headers: headers(third),
          });
        const checkout = await (
          await fetch(facilitatorUrl + "/v1/relay/pay", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              orderId: created.id,
              payer: payer.address,
              validAfter,
              validBefore,
              signature: paySignature,
            }),
          })
        ).json();
        expect(checkout.txHash).toBeTruthy();
        const agentHash = await minePayment(third);
        await pub.waitForTransactionReceipt({ hash: checkout.txHash });
        await rpcCall("evm_mine");
        const signal = await agentPromise;
        expect(signal.status).toBe(200);
        expect((await signal.json()).demo).toBe(true);
        for (
          let i = 0;
          i < 100 && svc.getOrder(created.id).status !== "settled";
          i++
        )
          await pause();
        expect(svc.getOrder(created.id).status).toBe("settled");
        const [agentTx, checkoutTx] = await Promise.all([
          pub.getTransaction({ hash: agentHash as Hex }),
          pub.getTransaction({ hash: checkout.txHash }),
        ]);
        expect(agentTx.from).toBe(checkoutTx.from);
        expect(Math.abs(agentTx.nonce - checkoutTx.nonce)).toBe(1);
        expect(agentTx.to?.toLowerCase()).toBe(token.toLowerCase());
        const balance = (address: Hex) =>
          pub.readContract({
            address: token,
            abi: tokenArtifact.abi,
            functionName: "balanceOf",
            args: [address],
          }) as Promise<bigint>;
        // Exercise the actual client and scripted agent over HTTP against the real chain.
        const agent = createAgent({
          signer: payer,
          chainId: 31337,
          asset: token,
          domainName: "Tether USD",
          domainVersion: "1",
          allowedOrigins: [apiUrl],
          allowedPayTo: [payTo],
          perCallLimit: 20000n,
          sessionBudget: 30000n,
          explorerUrl: "https://example.invalid",
        });
        // The facilitator waits for two confirmations. Mine as Anvil normally mines only on txs.
        let mining = false;
        const ticker = setInterval(() => {
          if (mining) return;
          mining = true;
          void rpcCall("evm_mine").finally(() => {
            mining = false;
          });
        }, 100);
        try {
          const demo = await runDemo(agent, apiUrl, { retryDelayMs: 25 });
          expect(demo).toHaveLength(2);
          expect(agent.reservedAmount).toBe(30000n);
          const hashes = new Set(
            demo.map((entry) => entry.payment.transaction),
          );
          expect(hashes.size).toBe(2);
          for (const entry of demo) {
            expect(entry.payment.explorerUrl).toContain(
              `/tx/${entry.payment.transaction}`,
            );
            expect(
              (
                await pub.getTransactionReceipt({
                  hash: entry.payment.transaction!,
                })
              ).status,
            ).toBe("success");
          }
        } finally {
          clearInterval(ticker);
        }
        expect(await balance(payTo)).toBe(70000n);
        expect(await balance(payout)).toBe(950000n);
        expect(await balance(payer.address)).toBe(98930000n);
        expect(await pub.getBalance({ address: payer.address })).toBe(0n);
        expect(
          db.raw.prepare("SELECT COUNT(*) n FROM x402_payments").get(),
        ).toEqual({ n: 5 });
        expect(db.attempts(created.id)).toHaveLength(1);
        expect(db.spentSince(0)).toBeGreaterThan(0n);
        await rpcCall("evm_mine");
        const scope = {
          chainId: 31337,
          router,
          token,
          deploymentBlock: Number(deployment.blockNumber),
          confirmations: 2,
          agent: { payTo, merchantId: merchant },
        };
        const ledgerDb = new IndexDb(":memory:", scope),
          indexer = new Indexer(ledgerDb, makeReader(rpc, scope), scope);
        const exported = await indexer.export({ merchantId: merchant });
        const rows = readCsv(exported.csv);
        expect(rows.filter((r) => r.source === "x402")).toHaveLength(5);
        expect(rows.filter((r) => r.source === "router")).toHaveLength(1);
        expect(
          (
            await verifyExport(makeReader(rpc, scope), scope, exported, {
              merchantId: merchant,
            })
          ).ok,
        ).toBe(true);
        ledgerDb.close();
      } finally {
        await api.close();
        await app.close();
        facilitator.stop();
        svc.stopMonitor();
        db.close();
      }
    }, 90000);
  },
);
