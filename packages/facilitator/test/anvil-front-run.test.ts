import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Db, RelayerService, makeChain } from "@quietpay/relayer/core";
import { buildAgentAuthorization, makePaidPolicies, type FacilitatorRequest } from "@quietpay/shared";
import { makeCfg } from "../../relayer/test/helpers.js";
import { FacilitatorService } from "../src/service.js";

// Backend audit F13 on a real chain: a third party submits the agent's signed authorization with a higher tip,
// so it is mined first and OUR transfer reverts ("auth used"). The payee was paid exactly once; the facilitator
// must report the payment as settled by the foreign tx, not failed, and must keep our wasted gas in the budget.

const here = dirname(fileURLToPath(import.meta.url)),
  out = process.env.CONTRACTS_OUT ?? resolve(here, "../../../contracts/out");
const anvilBin = process.env.ANVIL_BIN ?? "anvil";
const ready =
  existsSync(join(out, "PaymentRouter.sol/PaymentRouter.json")) &&
  spawnSync(anvilBin, ["--version"], { stdio: "ignore" }).status === 0;
if (process.env.CI && !ready)
  throw new Error("front-run integration requires compiled contracts and Anvil");

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

describe.skipIf(!ready)("F13 front-run on a real chain", () => {
  let anvil: ReturnType<typeof spawn> | undefined;
  let rpc = "";
  const call = async (method: string, params: unknown[] = []) => {
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
  beforeAll(async () => {
    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn(anvilBin, ["--port", String(port), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 120; i++) {
      try {
        await call("eth_chainId");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error("Anvil failed to start");
  }, 20000);
  afterAll(() => anvil?.kill());

  it("settles with the attacker's tx hash, pays the payee exactly once and keeps our reverted gas in the spend ledger", async () => {
    const chain = {
      id: 31337,
      name: "Anvil",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    } as const;
    const owner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const relayerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
    const attacker = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    const payer = privateKeyToAccount(generatePrivateKey());
    const wallet = createWalletClient({ chain, account: owner, transport: http(rpc) });
    const evil = createWalletClient({ chain, account: attacker, transport: http(rpc) });
    const pub = createPublicClient({ chain, transport: http(rpc) });
    const artifact = (name: string) =>
      JSON.parse(readFileSync(join(out, `${name}.sol/${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const tokenArt = artifact("MockTransferAuthToken"),
      routerArt = artifact("PaymentRouter");
    const token = (
      await pub.waitForTransactionReceipt({
        hash: await wallet.deployContract({ abi: tokenArt.abi, bytecode: tokenArt.bytecode.object }),
      })
    ).contractAddress!;
    const router = (
      await pub.waitForTransactionReceipt({
        hash: await wallet.deployContract({ abi: routerArt.abi, bytecode: routerArt.bytecode.object, args: [token, owner.address] }),
      })
    ).contractAddress!;
    const payTo = "0x3333333333333333333333333333333333333333" as Hex;
    const merchant = ("0x" + "ab".repeat(32)) as Hex;
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: token, abi: tokenArt.abi, functionName: "mint", args: [payer.address, 100_000_000n] }),
    });
    const balance = (a: Hex) =>
      pub.readContract({ address: token, abi: tokenArt.abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

    const cfg = makeCfg({ rpcUrl: rpc, chainId: 31337, usdt: token, router, relayerKey, lossBudgetWei: 10n ** 18n });
    const db = new Db(":memory:");
    const svc = new RelayerService({
      cfg,
      db,
      chain: makeChain({ rpcUrl: rpc, chainId: 31337, router, relayerKey, nonceFloor: () => db.nonceFloor() }),
    });
    const policies = makePaidPolicies({
      baseUrl: "https://api.test",
      merchantId: merchant,
      payTo,
      asset: token,
      chainId: 31337,
      name: "Tether USD",
      version: "1",
    });
    const facilitator = new FacilitatorService(svc, { policies, settlementWaitMs: 300, leaseSeconds: 3 });
    const requirements = policies[0]!.requirements;
    const value = BigInt(requirements.amount);
    const now = Math.floor(Date.now() / 1000);
    const nonce = ("0x" + "01".padStart(64, "0")) as Hex;
    const auth = { from: payer.address, to: payTo, value: String(value), validAfter: "0", validBefore: String(now + 55), nonce };
    const signature = await payer.signTypedData(
      buildAgentAuthorization({
        from: payer.address,
        to: payTo,
        value,
        validAfter: 0n,
        validBefore: BigInt(auth.validBefore),
        nonce,
        chainId: 31337,
        token,
      }),
    );
    const req: FacilitatorRequest = {
      x402Version: 2,
      paymentRequirements: requirements,
      paymentPayload: { x402Version: 2, resource: policies[0]!.resource, accepted: requirements, payload: { authorization: auth, signature } },
    };

    const relayerAddress = privateKeyToAccount(relayerKey).address;
    const relayerNonceBefore = await pub.getTransactionCount({ address: relayerAddress });
    await call("evm_setAutomine", [false]);
    try {
      const first = await facilitator.settle(req, merchant);
      expect(first).toMatchObject({ success: false, errorReason: "settlement_pending" });
      // The third party submits the same signed authorization with a much higher tip, so it is mined first.
      const v = parseInt(signature.slice(-2), 16) < 27 ? parseInt(signature.slice(-2), 16) + 27 : parseInt(signature.slice(-2), 16);
      const attackHash = await evil.writeContract({
        address: token,
        abi: tokenArt.abi,
        functionName: "transferWithAuthorization",
        args: [payer.address, payTo, value, 0n, BigInt(auth.validBefore), nonce, v, signature.slice(0, 66) as Hex, ("0x" + signature.slice(66, 130)) as Hex],
        gas: 200_000n, // fixed limit: estimation would run against the pending block that already holds our tx
        maxPriorityFeePerGas: 10n ** 10n,
        maxFeePerGas: 10n ** 11n,
      });
      await call("evm_mine");
      await call("evm_mine");
      await call("evm_mine");

      const row = () =>
        db.raw.prepare("SELECT * FROM x402_payments WHERE nonce=?").get(nonce) as Record<string, unknown>;
      await vi.waitFor(
        async () => {
          await facilitator.recover(row().id as string);
          expect(row().status).toBe("settled");
        },
        { timeout: 15000, interval: 200 },
      );
      expect(String(row().tx_hash).toLowerCase()).toBe(attackHash.toLowerCase());
      expect(row().settlement_source).toBe("external");
      expect(row().error_reason).toBeNull();

      // our own transfer was mined, reverted, and burned gas that still counts against the loss budget
      expect(await pub.getTransactionCount({ address: relayerAddress })).toBe(relayerNonceBefore + 1);
      const ours = db.attempts(row().id as string);
      expect(ours).toHaveLength(1);
      expect(String(ours[0]!.hash).toLowerCase()).not.toBe(attackHash.toLowerCase());
      expect((await pub.getTransactionReceipt({ hash: ours[0]!.hash as Hex })).status).toBe("reverted");
      expect(db.raw.prepare("SELECT COUNT(*) n FROM spend WHERE tx_hash=?").get(ours[0]!.hash)).toEqual({ n: 1 });

      // the payee was paid exactly once, and the retried settle reports success with the foreign hash
      expect(await balance(payTo)).toBe(value);
      const again = await facilitator.settle(req, merchant);
      expect(again).toMatchObject({ success: true });
      expect(String(again.transaction).toLowerCase()).toBe(attackHash.toLowerCase());
      expect(facilitator.claim(req, merchant).success).toBe(true);
      expect(facilitator.claim(req, merchant).success).toBe(false);
    } finally {
      await call("evm_setAutomine", [true]);
      facilitator.stop();
      svc.stopMonitor();
      db.close();
    }
  }, 60000);
});
