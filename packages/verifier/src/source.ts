import { createPublicClient, http, type Hex } from "viem";
import type { VerifierSource } from "./types.js";

const hex = (n: number) => `0x${n.toString(16)}`;

/** The verifier's own read-only RPC client: eth_chainId, eth_blockNumber, eth_getLogs, eth_getBlockByNumber. */
export function makeVerifierSource(rpcUrl: string): VerifierSource {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) });
  const req = client.request as unknown as (a: { method: string; params: unknown[] }) => Promise<unknown>;
  return {
    getChainId: () => client.getChainId(),
    async getBlockNumber() {
      return Number(await client.getBlockNumber());
    },
    async getLogs(q) {
      const raw = (await req({
        method: "eth_getLogs",
        params: [{ address: q.address, fromBlock: hex(q.fromBlock), toBlock: hex(q.toBlock), topics: q.topics }],
      })) as { address: string; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; topics: Hex[]; data: Hex; removed?: boolean }[];
      return raw
        .filter((l) => !l.removed)
        .map((l) => ({
          address: l.address.toLowerCase(),
          blockNumber: Number(BigInt(l.blockNumber)),
          blockHash: l.blockHash.toLowerCase(),
          transactionHash: l.transactionHash.toLowerCase(),
          logIndex: Number(BigInt(l.logIndex)),
          topics: l.topics.map((x) => x.toLowerCase()),
          data: l.data,
        }));
    },
    async getBlock(n) {
      const b = await client.getBlock({ blockNumber: BigInt(n) });
      return { hash: b.hash.toLowerCase(), timestamp: Number(b.timestamp) };
    },
  };
}
