import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { keccak256, parseTransaction, recoverTransactionAddress, type TransactionSerializedLegacy } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeChain, NonceManager, type PayArgs } from "../src/chain.js";
import { makeCfg, MERCHANT_ID, payer } from "./helpers.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((r, j) => { server.close(e => e ? j(e) : r()); server.closeAllConnections(); }); });

describe("real chain adapter signing", () => {
  it("persists a verifiable router-only transaction and uses the durable nonce floor", async () => {
    const requests: { method: string; params: unknown[] }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const call = JSON.parse(body); requests.push(call);
      const result = call.method === "eth_getTransactionCount" ? "0x2"
        : call.method === "eth_chainId" ? "0x752"
        : call.method === "eth_sendRawTransaction" ? keccak256(call.params[0]) : "0x0";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const address = server.address() as { port: number };
    const cfg = makeCfg();
    const chain = makeChain({ ...cfg, rpcUrl: `http://127.0.0.1:${address.port}`, nonceFloor: () => 8 });
    const args: PayArgs = { merchantId: MERCHANT_ID, orderId: MERCHANT_ID,
      payer: payer.address, value: 1_000_000n, fee: 50_000n, validAfter: 1n,
      validBefore: 301n, signature: ("0x" + "11".repeat(65)) as `0x${string}` };
    const prepared = await chain.preparePay(args, 180_000n, 1_000_000_000n);
    expect(requests.some(r => r.method === "eth_sendRawTransaction")).toBe(false);
    expect(prepared.hash).toBe(keccak256(prepared.raw));
    expect(parseTransaction(prepared.raw)).toMatchObject({ nonce: 8, chainId: 1874,
      to: cfg.router, gas: 180_000n, gasPrice: 1_000_000_000n });
    expect(parseTransaction(prepared.raw).value ?? 0n).toBe(0n);
    expect(await recoverTransactionAddress({ serializedTransaction: prepared.raw as TransactionSerializedLegacy })).toBe(privateKeyToAccount(cfg.relayerKey).address);
    expect(await chain.broadcast(prepared.raw)).toBe(prepared.hash);
    const replacement = await chain.preparePay(args, 180_000n, 1_125_000_000n, 8);
    expect(replacement.nonce).toBe(8);
    expect(replacement.hash).not.toBe(prepared.hash);
    expect((await chain.preparePay(args, 180_000n, 1_000_000_000n)).nonce).toBe(9);
  });

  it("serializes nonce allocation and resyncs after a failed preparation", async () => {
    let pending = 7;
    const nonces = new NonceManager(async () => pending);
    expect(await Promise.all([nonces.run(async n => n), nonces.run(async n => n)])).toEqual([7, 8]);
    await expect(nonces.run(async () => { throw new Error("sign failed"); })).rejects.toThrow("sign failed");
    pending = 12;
    expect(await nonces.run(async n => n)).toBe(12);
  });
});
