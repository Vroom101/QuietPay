/**
 * The viem-backed ChainPort's crash-safe broadcast primitives against a local anvil (no contracts needed:
 * the "router" is a code-less address, so pay() calls simply succeed). Local only; no testnet.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, type Hex } from "viem";
import { makeChain, type PayArgs } from "../src/chain.js";
import { assertPortFree, requireInCi, waitForRpc } from "./anvil-util.js";

const PORT = 18571;
const RPC = `http://127.0.0.1:${PORT}`;
// Standard anvil dev key #2 (public, test-only).
const RELAYER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const hasAnvil = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
requireInCi(hasAnvil, "anvil");

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const args: PayArgs = {
  merchantId: ("0x" + "01".repeat(32)) as Hex,
  orderId: ("0x" + "02".repeat(32)) as Hex,
  payer: "0x2222222222222222222222222222222222222222",
  value: 2n,
  fee: 1n,
  validAfter: 0n,
  validBefore: 1n,
  signature: ("0x" + "00".repeat(65)) as Hex,
};

describe.skipIf(!hasAnvil)("chain on anvil: sign locally, persist, send, look up", () => {
  let anvil: ChildProcess;
  beforeAll(async () => {
    await assertPortFree(PORT);
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    await waitForRpc(RPC);
  }, 30_000);
  afterAll(() => {
    anvil?.kill();
  });

  it("signPay does not broadcast; the hash is the keccak of the raw bytes; lookups distinguish unknown, pending and mined", async () => {
    const chain = makeChain({ rpcUrl: RPC, chainId: 31337, router: "0x000000000000000000000000000000000000dEaD", relayerKey: RELAYER_KEY });
    await rpc("evm_setAutomine", [false]);
    try {
      const gasPrice = await chain.getGasPrice();
      const s = await chain.signPay(args, 200_000n, gasPrice);
      expect(s.hash).toBe(keccak256(s.raw));
      expect(s.nonce).toBe(0);
      // Signed but never sent (a crash right here): the node knows nothing, the nonce is unused.
      expect(await chain.hasTransaction(s.hash)).toBe(false);
      expect(await chain.getReceipt(s.hash)).toBeNull();
      expect(await chain.getConfirmedNonce()).toBe(0);
      // The persisted raw bytes can be sent later, as often as needed, with the same hash.
      expect(await chain.sendRawTx(s.raw)).toBe(s.hash);
      expect(await chain.hasTransaction(s.hash)).toBe(true);
      expect(await chain.getReceipt(s.hash)).toBeNull(); // in the mempool, not mined
      await chain.sendRawTx(s.raw).catch(() => undefined); // re-send of the same bytes is harmless
      await rpc("evm_mine");
      const r = await chain.getReceipt(s.hash);
      expect(r?.status).toBe("success");
      expect(await chain.getConfirmedNonce()).toBe(1);
      // The next signature continues the managed nonce sequence.
      const s2 = await chain.signPay(args, 200_000n, gasPrice);
      expect(s2.nonce).toBe(1);
      // A tx replaced at the same nonce: its own hash never gets a receipt and the mined nonce moves past it.
      chain.resyncNonce();
      const s3 = await chain.signPay({ ...args, value: 3n }, 200_000n, gasPrice); // refetches pending nonce = 1
      expect(s3.nonce).toBe(1);
      await chain.sendRawTx(s3.raw);
      await rpc("evm_mine");
      expect(await chain.getConfirmedNonce()).toBe(2);
      expect(await chain.getReceipt(s2.hash)).toBeNull();
      await expect(chain.sendRawTx(s2.raw)).rejects.toThrow(); // nonce too low
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
  }, 60_000);
});
