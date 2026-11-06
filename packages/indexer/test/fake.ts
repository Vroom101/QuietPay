import { encodeAbiParameters, encodeEventTopics, pad, parseAbi, type Abi, type AbiEvent, type Hex } from "viem";
import { paymentRouterAbi } from "@quietpay/shared";
import type { ChainLog } from "../src/types.js";
import type { LogSource } from "../src/rpc.js";
import type { IndexerConfig } from "../src/indexer.js";

export const ROUTER = "0x6a765694262e1c9cdddb1c76008a61df7f58d86f";
export const USDT = "0x02dd211c97b0611146ce9d673f9c56b4fbc9e6f4";
export const PAYTO = "0x7777777777777777777777777777777777777777";
export const PAYER = "0x3333333333333333333333333333333333333333";
export const PAYOUT = "0x2222222222222222222222222222222222222222";
export const RELAYER = "0x4444444444444444444444444444444444444444";
export const MERCHANT = "0x" + "01".repeat(32);
export const T0 = 1_800_000_000;

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

function encode(abi: Abi, eventName: string, args: Record<string, unknown>): { topics: string[]; data: string } {
  const ev = (abi as readonly AbiEvent[]).find((x) => x.type === "event" && x.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as string[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
  return { topics: topics.map((t) => t.toLowerCase()), data };
}

let txCounter = 0;
export function txHash(n?: number): string {
  return "0x" + (n ?? ++txCounter).toString(16).padStart(64, "0");
}

export interface LogSpec {
  block: number;
  tx?: string;
  logIndex?: number;
}

export function paidLog(s: LogSpec & { orderId: string; value: bigint; fee: bigint; payout?: string; payer?: string }): ChainLog {
  const { topics, data } = encode(paymentRouterAbi as Abi, "Paid", {
    merchantId: MERCHANT,
    orderId: s.orderId,
    payer: s.payer ?? PAYER,
    payout: s.payout ?? PAYOUT,
    value: s.value,
    fee: s.fee,
    relayer: RELAYER,
  });
  return mk(ROUTER, topics, data, s);
}

export function refundedLog(s: LogSpec & { orderId: string; amount: bigint; total: bigint; index: number }): ChainLog {
  const { topics, data } = encode(paymentRouterAbi as Abi, "Refunded", {
    merchantId: MERCHANT,
    orderId: s.orderId,
    payer: PAYER,
    amount: s.amount,
    totalRefunded: s.total,
    refundIndex: BigInt(s.index),
  });
  return mk(ROUTER, topics, data, s);
}

export function transferLog(s: LogSpec & { from: string; to: string; value: bigint }): ChainLog {
  const { topics, data } = encode(transferAbi as unknown as Abi, "Transfer", { from: s.from, to: s.to, value: s.value });
  return mk(USDT, topics, data, s);
}

function mk(address: string, topics: string[], data: string, s: LogSpec): ChainLog {
  return {
    address,
    blockNumber: s.block,
    blockHash: blockHash(s.block, 0),
    transactionHash: s.tx ?? txHash(),
    logIndex: s.logIndex ?? 0,
    topics,
    data,
  };
}

export const order = (n: number) => "0x" + n.toString(16).padStart(64, "0");

export function blockHash(n: number, fork: number): string {
  return "0x" + fork.toString(16).padStart(2, "0") + n.toString(16).padStart(62, "0");
}

/** An in-memory chain. Logs are placed by block; `fork` changes block hashes (to simulate a reorg). */
export class FakeChain implements LogSource {
  head: number;
  fork = 0;
  /** Blocks above this number take the forked hash; the default (-1) forks every block. */
  forkAbove = -1;
  logs: ChainLog[] = [];
  maxRange = Infinity; // ranges wider than this get a -32062 error
  requests: [number, number][] = [];
  errors = 0;

  constructor(head: number) {
    this.head = head;
  }

  add(...l: ChainLog[]) {
    this.logs.push(...l);
  }

  async getBlockNumber() {
    return this.head;
  }

  async getBlock(n: number) {
    return { hash: blockHash(n, n > this.forkAbove ? this.fork : 0), timestamp: T0 + n };
  }

  async getLogs(q: { address: string; fromBlock: number; toBlock: number; topics?: (string | null)[] }) {
    this.requests.push([q.fromBlock, q.toBlock]);
    if (q.toBlock - q.fromBlock + 1 > this.maxRange) {
      this.errors += 1;
      throw Object.assign(new Error("Block range is too large"), { code: -32062 });
    }
    return this.logs
      .filter((l) => l.address.toLowerCase() === q.address.toLowerCase())
      .filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock)
      .filter((l) => (q.topics ?? []).every((t, i) => t === null || t === undefined || l.topics[i]?.toLowerCase() === t.toLowerCase()))
      .map((l) => ({ ...l, blockHash: blockHash(l.blockNumber, l.blockNumber > this.forkAbove ? this.fork : 0) }));
  }
}

export function cfg(over: Partial<IndexerConfig> = {}): IndexerConfig {
  return { router: ROUTER, usdt: USDT, facilitatorPayTo: PAYTO, confirmations: 12, deployBlock: 100, ...over };
}

export const padAddr = (a: string) => pad(a as Hex, { size: 32 });
