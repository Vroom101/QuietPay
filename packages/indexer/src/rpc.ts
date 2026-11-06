import { createPublicClient, http, type Hex } from "viem";
import type { ChainLog } from "./types.js";

export interface LogQuery {
  address: string;
  /** topics[0] is the event signature; null entries are wildcards. */
  topics?: (string | null)[];
}

/** Everything the indexer needs from a node. Faked in tests, viem-backed in production. */
export interface LogSource {
  getBlockNumber(): Promise<number>;
  getLogs(q: LogQuery & { fromBlock: number; toBlock: number }): Promise<ChainLog[]>;
  getBlock(n: number): Promise<{ hash: string; timestamp: number }>;
}

export const MAX_PAGE = 1000;

function errText(e: unknown): string {
  const x = e as { code?: number; message?: string; details?: string; cause?: unknown; shortMessage?: string };
  return `${x?.code ?? ""} ${x?.message ?? ""} ${x?.details ?? ""} ${x?.shortMessage ?? ""} ${x?.cause ? errText(x.cause) : ""}`;
}

/** The Ankr testnet endpoint answers an over-wide range with -32062 ("Block range is too large"). */
export function isRangeError(e: unknown): boolean {
  return /-32062|block range|range is too (large|wide)|too many (blocks|results)|query returned more than/i.test(errText(e));
}

export function isRateLimit(e: unknown): boolean {
  return /429|-32005|-32007|rate.?limit|too many requests|exceeded/i.test(errText(e)) && !isRangeError(e);
}

export interface PagingOptions {
  pageSize?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called with each page range that was requested, in order (including pages that failed and were halved). */
  onRequest?: (from: number, to: number) => void;
}

/**
 * Reads logs for [from, to] in pages of at most `pageSize` (default 1,000) blocks.
 * A range error halves the page and retries; a rate limit backs off exponentially.
 */
export async function getLogsPaged(
  src: LogSource,
  q: LogQuery,
  from: number,
  to: number,
  opts: PagingOptions = {},
): Promise<ChainLog[]> {
  let page = Math.min(opts.pageSize ?? MAX_PAGE, MAX_PAGE);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 8;
  const out: ChainLog[] = [];
  let start = from;
  let retries = 0;
  while (start <= to) {
    const end = Math.min(start + page - 1, to);
    opts.onRequest?.(start, end);
    try {
      out.push(...(await src.getLogs({ ...q, fromBlock: start, toBlock: end })));
      start = end + 1;
      retries = 0;
    } catch (e) {
      if (isRangeError(e) && page > 1) {
        page = Math.max(1, Math.floor(page / 2));
        continue;
      }
      if (isRateLimit(e) && retries < maxRetries) {
        await sleep(Math.min(30_000, 500 * 2 ** retries));
        retries += 1;
        continue;
      }
      throw e;
    }
  }
  return out;
}

const hex = (n: number) => `0x${n.toString(16)}`;

export function makeLogSource(rpcUrl: string): LogSource {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) });
  const req = client.request as unknown as (a: { method: string; params: unknown[] }) => Promise<unknown>;
  return {
    async getBlockNumber() {
      return Number(await client.getBlockNumber());
    },
    async getLogs(q) {
      const raw = (await req({
        method: "eth_getLogs",
        params: [{ address: q.address, fromBlock: hex(q.fromBlock), toBlock: hex(q.toBlock), topics: q.topics }],
      })) as {
        address: string;
        blockNumber: Hex;
        blockHash: Hex;
        transactionHash: Hex;
        logIndex: Hex;
        topics: Hex[];
        data: Hex;
        removed?: boolean;
      }[];
      return raw
        .filter((l) => !l.removed)
        .map((l) => ({
          address: l.address.toLowerCase(),
          blockNumber: Number(BigInt(l.blockNumber)),
          blockHash: l.blockHash.toLowerCase(),
          transactionHash: l.transactionHash.toLowerCase(),
          logIndex: Number(BigInt(l.logIndex)),
          topics: l.topics.map((t) => t.toLowerCase()),
          data: l.data,
        }));
    },
    async getBlock(n) {
      const b = await client.getBlock({ blockNumber: BigInt(n) });
      return { hash: b.hash.toLowerCase(), timestamp: Number(b.timestamp) };
    },
  };
}
