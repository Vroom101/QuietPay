import { createPublicClient, http } from "viem";
import { makeLogSource } from "@quietpay/indexer";
import type { VerifierSource } from "./types.js";

/** viem-backed source: the indexer's paged-log source plus eth_chainId. Read-only calls only. */
export function makeVerifierSource(rpcUrl: string): VerifierSource {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) });
  const logs = makeLogSource(rpcUrl);
  return {
    getBlockNumber: () => logs.getBlockNumber(),
    getLogs: (q) => logs.getLogs(q),
    getBlock: (n) => logs.getBlock(n),
    getChainId: () => client.getChainId(),
  };
}
