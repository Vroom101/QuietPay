import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Db, RelayerService, makeChain } from "@quietpay/relayer/core";
import {
  buildAgentAuthorization,
  makePaidPolicies,
  type FacilitatorRequest,
} from "@quietpay/shared";
import { makeCfg } from "../../relayer/test/helpers.js";
import { FacilitatorService } from "../src/service.js";

// Shared real-chain kit for the W6 tests: boots anvil on a free port, deploys the real PaymentRouter plus a mock
// EIP-3009 token (the repo mock, or the cancel-capable test fixture), and signs agent authorizations.

const here = dirname(fileURLToPath(import.meta.url)),
  out = process.env.CONTRACTS_OUT ?? resolve(here, "../../../contracts/out");
export const anvilBin = process.env.ANVIL_BIN ?? "anvil";
export const chainReady =
  existsSync(join(out, "PaymentRouter.sol/PaymentRouter.json")) &&
  existsSync(join(out, "MockTransferAuthToken.sol/MockTransferAuthToken.json")) &&
  spawnSync(anvilBin, ["--version"], { stdio: "ignore" }).status === 0;
if (process.env.CI && !chainReady)
  throw new Error("anvil integration requires compiled contracts and Anvil");

export const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  attacker: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
};
const range = process.env.ANVIL_PORT_BASE ? Number(process.env.ANVIL_PORT_BASE) : 8785;
const freePort = async () => {
  const start = Math.floor(Math.random() * 20);
  for (let i = 0; i < 20; i++) {
    const p = range + ((start + i) % 20);
    const ok = await new Promise<boolean>((res) => {
      const s = createServer();
      s.once("error", () => res(false));
      s.listen(p, "127.0.0.1", () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error("no free anvil port in the stream range");
};
const artifact = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: { object: Hex } | Hex };
const fixture = (name: string) => resolve(here, "fixtures", name);

export async function startAnvil() {
  const port = await freePort(),
    rpc = `http://127.0.0.1:${port}`;
  const proc = spawn(anvilBin, ["--port", String(port), "--silent"], { stdio: "ignore" });
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
  for (let i = 0; i < 200; i++) {
    try {
      await call("eth_chainId");
      return { rpc, call, stop: () => proc.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  proc.kill();
  throw new Error("Anvil failed to start");
}

export interface World {
  rpc: string;
  call: (method: string, params?: unknown[]) => Promise<any>;
  pub: ReturnType<typeof createPublicClient>;
  token: Hex;
  tokenAbi: Abi;
  router: Hex;
  chainId: number;
  payTo: Hex;
  merchant: Hex;
  attacker: ReturnType<typeof createWalletClient>;
  relayerAddress: Hex;
  balance: (a: Hex) => Promise<bigint>;
  mint: (to: Hex, amount: bigint) => Promise<void>;
  newPayer: (amount?: bigint) => Promise<ReturnType<typeof privateKeyToAccount>>;
  makeServices: (over?: Parameters<typeof makeCfg>[0], opts?: { waitMs?: number }) => {
    cfg: ReturnType<typeof makeCfg>;
    db: Db;
    svc: RelayerService;
    facilitator: FacilitatorService;
    policies: ReturnType<typeof makePaidPolicies>;
    close: () => void;
  };
  sign: (args: {
    payer: ReturnType<typeof privateKeyToAccount>;
    policy: ReturnType<typeof makePaidPolicies>[number];
    nonceN: number;
    to?: Hex;
    value?: bigint;
    validBeforeIn?: number;
    chainId?: number;
    token?: Hex;
  }) => Promise<FacilitatorRequest>;
  /** A third party submits the agent's authorization straight to the token with a high tip. */
  frontRun: (req: FacilitatorRequest) => Promise<Hex>;
  /** The payer signs and a third party submits CancelAuthorization (cancel-capable token only). */
  cancel: (payer: ReturnType<typeof privateKeyToAccount>, nonce: Hex) => Promise<Hex>;
}

export async function deployWorld(rpc: string, call: World["call"], cancelable = false): Promise<World> {
  const chainId = 31337;
  const chain = {
    id: chainId,
    name: "Anvil",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  } as const;
  const owner = privateKeyToAccount(KEYS.owner);
  const wallet = createWalletClient({ chain, account: owner, transport: http(rpc) });
  const evil = createWalletClient({ chain, account: privateKeyToAccount(KEYS.attacker), transport: http(rpc) });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const tokenArt = cancelable
    ? artifact(fixture("CancelableToken.json"))
    : artifact(join(out, "MockTransferAuthToken.sol/MockTransferAuthToken.json"));
  const routerArt = artifact(join(out, "PaymentRouter.sol/PaymentRouter.json"));
  const code = (a: { bytecode: { object: Hex } | Hex }) => (typeof a.bytecode === "string" ? a.bytecode : a.bytecode.object);
  const token = (
    await pub.waitForTransactionReceipt({
      hash: await wallet.deployContract({ abi: tokenArt.abi, bytecode: code(tokenArt) }),
    })
  ).contractAddress!;
  const router = (
    await pub.waitForTransactionReceipt({
      hash: await wallet.deployContract({ abi: routerArt.abi, bytecode: code(routerArt), args: [token, owner.address] }),
    })
  ).contractAddress!;
  const payTo = "0x3333333333333333333333333333333333333333" as Hex;
  const merchant = ("0x" + "ab".repeat(32)) as Hex;
  const balance = (a: Hex) => pub.readContract({ address: token, abi: tokenArt.abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
  const mint = async (to: Hex, amount: bigint) => {
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: token, abi: tokenArt.abi, functionName: "mint", args: [to, amount] }),
    });
  };
  const split = (signature: Hex) => {
    const raw = parseInt(signature.slice(-2), 16);
    return [raw < 27 ? raw + 27 : raw, signature.slice(0, 66) as Hex, ("0x" + signature.slice(66, 130)) as Hex] as const;
  };
  return {
    rpc,
    call,
    pub,
    token,
    tokenAbi: tokenArt.abi,
    router,
    chainId,
    payTo,
    merchant,
    attacker: evil,
    relayerAddress: privateKeyToAccount(KEYS.relayer).address,
    balance,
    mint,
    newPayer: async (amount = 100_000_000n) => {
      const p = privateKeyToAccount(generatePrivateKey());
      await mint(p.address, amount);
      return p;
    },
    makeServices: (over = {}, opts = {}) => {
      const cfg = makeCfg({
        rpcUrl: rpc,
        chainId,
        usdt: token,
        router,
        relayerKey: KEYS.relayer,
        lossBudgetWei: 10n ** 18n,
        ...over,
      });
      const db = new Db(":memory:");
      const svc = new RelayerService({
        cfg,
        db,
        chain: makeChain({ rpcUrl: rpc, chainId, router, relayerKey: KEYS.relayer, nonceFloor: () => db.nonceFloor() }),
      });
      const policies = makePaidPolicies({
        baseUrl: "https://api.test",
        merchantId: merchant,
        payTo,
        asset: token,
        chainId,
        name: "Tether USD",
        version: "1",
      });
      const facilitator = new FacilitatorService(svc, { policies, settlementWaitMs: opts.waitMs ?? 300, leaseSeconds: 3 });
      return {
        cfg,
        db,
        svc,
        facilitator,
        policies,
        close: () => {
          facilitator.stop();
          svc.stopMonitor();
          db.close();
        },
      };
    },
    sign: async ({ payer, policy, nonceN, to, value, validBeforeIn = 55, chainId: cid, token: tok }) => {
      const req = policy.requirements;
      const now = Math.floor(Date.now() / 1000);
      const auth = {
        from: payer.address,
        to: to ?? (req.payTo as Hex),
        value: String(value ?? BigInt(req.amount)),
        validAfter: "0",
        validBefore: String(now + validBeforeIn),
        nonce: ("0x" + nonceN.toString(16).padStart(64, "0")) as Hex,
      };
      const signature = await payer.signTypedData(
        buildAgentAuthorization({
          from: payer.address,
          to: auth.to as Hex,
          value: BigInt(auth.value),
          validAfter: 0n,
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce,
          chainId: cid ?? chainId,
          token: tok ?? token,
        }),
      );
      return {
        x402Version: 2,
        paymentRequirements: req,
        paymentPayload: { x402Version: 2, resource: policy.resource, accepted: req, payload: { authorization: auth, signature } },
      };
    },
    frontRun: async (req) => {
      const a = req.paymentPayload.payload.authorization;
      const [v, r, s] = split(req.paymentPayload.payload.signature as Hex);
      return evil.writeContract({
        address: token,
        abi: tokenArt.abi,
        functionName: "transferWithAuthorization",
        args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, r, s],
        gas: 200_000n, // fixed: estimation would run against the pending block that already holds our tx
        maxPriorityFeePerGas: 10n ** 10n,
        maxFeePerGas: 10n ** 11n,
      } as never);
    },
    cancel: async (payer, nonce) => {
      const domain = buildAgentAuthorization({
        from: payer.address,
        to: payer.address,
        value: 0n,
        validAfter: 0n,
        validBefore: 1n,
        nonce,
        chainId,
        token,
      }).domain;
      const signature = await payer.signTypedData({
        domain,
        types: {
          CancelAuthorization: [
            { name: "authorizer", type: "address" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "CancelAuthorization",
        message: { authorizer: payer.address, nonce },
      });
      const [v, r, s] = split(signature);
      return evil.writeContract({
        address: token,
        abi: tokenArt.abi,
        functionName: "cancelAuthorization",
        args: [payer.address, nonce, v, r, s],
        gas: 200_000n,
        maxPriorityFeePerGas: 10n ** 10n,
        maxFeePerGas: 10n ** 11n,
      } as never);
    },
  };
}
