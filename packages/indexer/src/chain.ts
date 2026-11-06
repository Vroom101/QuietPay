import {
  createPublicClient,
  http,
  getAbiItem,
  parseAbiItem,
  parseAbi,
  type Hex,
} from "viem";
import { paymentRouterAbi } from "@quietpay/shared";
import {
  normalizeScope,
  type Scope,
  type ChainEvent,
  type ChainReader,
  type Block,
  type RecordedEvent,
  uniqueEvents,
} from "./model.js";

export function makeReader(rpcUrl: string, config: Scope): ChainReader {
  const scope = normalizeScope(config);
  const client = createPublicClient({ transport: http(rpcUrl) });
  const events = [
    getAbiItem({ abi: paymentRouterAbi, name: "Paid" }),
    getAbiItem({ abi: paymentRouterAbi, name: "Refunded" }),
    getAbiItem({ abi: paymentRouterAbi, name: "MerchantRegistered" }),
    getAbiItem({ abi: paymentRouterAbi, name: "PayoutChanged" }),
  ] as const;
  return {
    async getChainId() {
      const actual = await client.getChainId();
      if (actual !== scope.chainId) return actual;
      const [routerToken, decimals] = await Promise.all([
        client.readContract({
          address: scope.router as Hex,
          abi: paymentRouterAbi,
          functionName: "token",
        }),
        client.readContract({
          address: scope.token as Hex,
          abi: parseAbi(["function decimals() view returns (uint8)"]),
          functionName: "decimals",
        }),
      ]);
      if (routerToken.toLowerCase() !== scope.token)
        throw new Error(
          "Router token does not match the configured ledger asset",
        );
      if (decimals !== 6)
        throw new Error("Ledger requires a six-decimal token");
      return actual;
    },
    getHead: async () => Number(await client.getBlockNumber({ cacheTime: 0 })),
    async getBlock(number) {
      const block = await client.getBlock({ blockNumber: BigInt(number) });
      if (!block.hash || block.number === null)
        throw new Error("Unconfirmed block returned by RPC");
      return {
        number: Number(block.number),
        hash: block.hash,
        timestamp: Number(block.timestamp),
      };
    },
    async getEvents(fromBlock, toBlock) {
      if (toBlock - fromBlock + 1 > 1000)
        throw new Error("Log page exceeds 1,000 blocks");
      const logs = await client.getLogs({
        address: scope.router as Hex,
        events,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
        strict: true,
      });
      const result: ChainEvent[] = logs.map((log) => {
        if (
          log.blockNumber === null ||
          !log.blockHash ||
          !log.transactionHash ||
          log.logIndex === null
        )
          throw new Error("Pending log returned by RPC");
        const location = {
          blockNumber: Number(log.blockNumber),
          blockHash: log.blockHash,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
        };
        switch (log.eventName) {
          case "Paid":
            return {
              ...location,
              type: "Paid",
              ...log.args,
              value: log.args.value.toString(),
              fee: log.args.fee.toString(),
            };
          case "Refunded":
            return {
              ...location,
              type: "Refunded",
              ...log.args,
              amount: log.args.amount.toString(),
              totalRefunded: log.args.totalRefunded.toString(),
              refundIndex: log.args.refundIndex.toString(),
            };
          case "MerchantRegistered":
            return {
              ...location,
              type: "MerchantRegistered",
              ...log.args,
              maxRelayFee: log.args.maxRelayFee.toString(),
            };
          case "PayoutChanged":
            return { ...location, type: "PayoutChanged", ...log.args };
        }
      });
      if (scope.agent) {
        const transfers = await client.getLogs({
          address: scope.token as Hex,
          event: parseAbiItem(
            "event Transfer(address indexed from, address indexed to, uint256 value)",
          ),
          args: { to: scope.agent.payTo as Hex },
          fromBlock: BigInt(fromBlock),
          toBlock: BigInt(toBlock),
          strict: true,
        });
        for (const log of transfers) {
          // Router payouts are already represented by Paid; never count them as agent sales.
          if (
            log.args.from.toLowerCase() === scope.router ||
            log.args.value === 0n
          )
            continue;
          if (
            log.blockNumber === null ||
            !log.blockHash ||
            !log.transactionHash ||
            log.logIndex === null
          )
            throw new Error("Pending transfer");
          result.push({
            type: "AgentTransfer",
            blockNumber: Number(log.blockNumber),
            blockHash: log.blockHash,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            merchantId: scope.agent.merchantId as Hex,
            payer: log.args.from,
            payTo: log.args.to,
            amount: log.args.value.toString(),
          });
        }
      }
      return result;
    },
  };
}

/** Read a stable page. Headers are needed only at event blocks and the page boundary. */
export async function readPage(
  chain: ChainReader,
  from: number,
  to: number,
): Promise<{ blocks: Block[]; events: RecordedEvent[] }> {
  if (to < from || to - from + 1 > 1000) throw new Error("Invalid log page");
  const endBefore = await chain.getBlock(to);
  const events = await chain.getEvents(from, to);
  if (events.some((e) => e.blockNumber < from || e.blockNumber > to))
    throw new Error("RPC returned a log outside the requested range");
  const numbers = [...new Set([to, ...events.map((e) => e.blockNumber)])];
  const blocks: Block[] = [];
  for (let i = 0; i < numbers.length; i += 8)
    blocks.push(
      ...(await Promise.all(
        numbers.slice(i, i + 8).map((n) => chain.getBlock(n)),
      )),
    );
  const endAfter = await chain.getBlock(to);
  if (
    endBefore.hash !== endAfter.hash ||
    blocks.find((b) => b.number === to)?.hash !== endAfter.hash
  )
    throw new Error("Chain changed while reading a page; retry");
  const byNumber = new Map(blocks.map((b) => [b.number, b]));
  for (const e of events) {
    if (
      e.blockNumber < from ||
      e.blockNumber > to ||
      byNumber.get(e.blockNumber)?.hash.toLowerCase() !==
        e.blockHash.toLowerCase()
    )
      throw new Error("Log does not match its canonical block");
  }
  return {
    blocks,
    events: uniqueEvents(
      events.map((event) => ({
        event,
        timestamp: byNumber.get(event.blockNumber)!.timestamp,
      })),
    ),
  };
}

export async function scan(
  chain: ChainReader,
  from: number,
  to: number,
  pageSize = 1000,
): Promise<RecordedEvent[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)
    throw new Error("Invalid page size");
  const result: RecordedEvent[] = [];
  for (let cursor = from; cursor <= to; cursor += pageSize)
    result.push(
      ...(await readPage(chain, cursor, Math.min(to, cursor + pageSize - 1)))
        .events,
    );
  return uniqueEvents(result);
}
