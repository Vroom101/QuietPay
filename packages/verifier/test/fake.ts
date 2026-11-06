import { encodeAbiParameters, encodeEventTopics, parseAbi, type Abi, type AbiEvent } from "viem";
import { paymentRouterAbi } from "@quietpay/shared";
import { IndexerDb, buildExport, indexOnce, type ChainLog } from "@quietpay/indexer";
import type { VerifierSource } from "../src/index.js";

export const ROUTER = "0x6a765694262e1c9cdddb1c76008a61df7f58d86f";
export const USDT = "0x02dd211c97b0611146ce9d673f9c56b4fbc9e6f4";
export const PAYTO = "0x7777777777777777777777777777777777777777";
export const PAYER = "0x3333333333333333333333333333333333333333";
export const PAYOUT = "0x2222222222222222222222222222222222222222";
export const RELAYER = "0x4444444444444444444444444444444444444444";
export const REFUND_SIGNER = "0x5555555555555555555555555555555555555555";
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

export const order = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export const blockHash = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function mk(address: string, block: number, txHash: string, logIndex: number, enc: { topics: string[]; data: string }): ChainLog {
  return { address, blockNumber: block, blockHash: blockHash(block), transactionHash: txHash, logIndex, ...enc };
}

export const transfer = (block: number, txHash: string, logIndex: number, from: string, to: string, value: bigint) =>
  mk(USDT, block, txHash, logIndex, encode(transferAbi as unknown as Abi, "Transfer", { from, to, value }));

export function merchantRegistered(block: number, txHash: string, logIndex = 0): ChainLog {
  return mk(ROUTER, block, txHash, logIndex, encode(paymentRouterAbi as Abi, "MerchantRegistered", {
    merchantId: MERCHANT,
    payout: PAYOUT,
    refundSigner: REFUND_SIGNER,
    maxRelayFee: 100_000n,
  }));
}

/** A router payment exactly as the real router emits it: pull, payout, fee, then Paid (all in one tx). */
export function payment(p: { block: number; tx: string; orderId: string; value: bigint; fee: bigint; payout?: string; payoutAmount?: bigint }): ChainLog[] {
  const payout = p.payout ?? PAYOUT;
  const logs = [transfer(p.block, p.tx, 0, PAYER, ROUTER, p.value), transfer(p.block, p.tx, 1, ROUTER, payout, p.payoutAmount ?? p.value - p.fee)];
  if (p.fee > 0n) logs.push(transfer(p.block, p.tx, 2, ROUTER, RELAYER, p.fee));
  logs.push(
    mk(ROUTER, p.block, p.tx, logs.length, encode(paymentRouterAbi as Abi, "Paid", {
      merchantId: MERCHANT,
      orderId: p.orderId,
      payer: PAYER,
      payout,
      value: p.value,
      fee: p.fee,
      relayer: RELAYER,
    })),
  );
  return logs;
}

export function refundSignerChanged(block: number, txHash: string, logIndex = 0, newSigner = "0x6666666666666666666666666666666666666666"): ChainLog {
  return mk(ROUTER, block, txHash, logIndex, encode(paymentRouterAbi as Abi, "RefundSignerChanged", { merchantId: MERCHANT, oldSigner: REFUND_SIGNER, newSigner }));
}

export function refund(p: { block: number; tx: string; orderId: string; amount: bigint; total: bigint; index: number }): ChainLog[] {
  return [
    transfer(p.block, p.tx, 0, REFUND_SIGNER, ROUTER, p.amount),
    transfer(p.block, p.tx, 1, ROUTER, PAYER, p.amount),
    mk(ROUTER, p.block, p.tx, 2, encode(paymentRouterAbi as Abi, "Refunded", {
      merchantId: MERCHANT,
      orderId: p.orderId,
      payer: PAYER,
      amount: p.amount,
      totalRefunded: p.total,
      refundIndex: BigInt(p.index),
    })),
  ];
}

/** An in-memory chain that answers like a node: eth_chainId, eth_blockNumber, eth_getLogs (with -32062), blocks. */
export class FakeChain implements VerifierSource {
  logs: ChainLog[] = [];
  maxRange = Infinity;
  requests: [number, number][] = [];
  failWith?: Error;
  constructor(public head: number, public chainId = 31337) {}
  add(...l: ChainLog[]) {
    this.logs.push(...l);
  }
  async getChainId() {
    if (this.failWith) throw this.failWith;
    return this.chainId;
  }
  async getBlockNumber() {
    return this.head;
  }
  async getBlock(n: number) {
    return { hash: blockHash(n), timestamp: T0 + n * 2 };
  }
  async getLogs(q: { address: string; fromBlock: number; toBlock: number; topics?: (string | null)[] }) {
    this.requests.push([q.fromBlock, q.toBlock]);
    if (q.toBlock - q.fromBlock + 1 > this.maxRange) throw Object.assign(new Error("Block range is too large"), { code: -32062 });
    return this.logs
      .filter((l) => l.address.toLowerCase() === q.address.toLowerCase())
      .filter((l) => l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock)
      .filter((l) => (q.topics ?? []).every((t, i) => t == null || l.topics[i]?.toLowerCase() === t.toLowerCase()));
  }
}

/**
 * The reference scenario. Rows: order 1 (partly refunded twice), order 2 (no fee), a bare payto deposit, and
 * order 3 whose payout IS the pay-to address (the double-count case).
 */
export function scenario(head = 400) {
  const chain = new FakeChain(head);
  chain.add(
    merchantRegistered(100, tx(0xa0)),
    ...payment({ block: 150, tx: tx(1), orderId: order(1), value: 25_000_000n, fee: 50_000n }),
    ...refund({ block: 160, tx: tx(2), orderId: order(1), amount: 5_000_000n, total: 5_000_000n, index: 0 }),
    ...payment({ block: 170, tx: tx(3), orderId: order(2), value: 1_000_000n, fee: 0n }),
    transfer(180, tx(4), 0, PAYER, PAYTO, 1_500_000n),
    ...refund({ block: 190, tx: tx(5), orderId: order(1), amount: 2_000_000n, total: 7_000_000n, index: 1 }),
    ...payment({ block: 200, tx: tx(6), orderId: order(3), value: 3_000_000n, fee: 100_000n, payout: PAYTO }),
  );
  return chain;
}

/** Produces the CSV and sidecar exactly as `pnpm cli export` does: index into a fresh DB, then buildExport. */
export async function exportWithIndexer(chain: FakeChain, opts: { from?: number; to?: number; payTo?: string | null; confirmations?: number } = {}) {
  const cfg = {
    router: ROUTER,
    usdt: USDT,
    facilitatorPayTo: opts.payTo === null ? undefined : (opts.payTo ?? PAYTO),
    confirmations: opts.confirmations ?? 12,
    deployBlock: 100,
  };
  const db = new IndexerDb(":memory:");
  await indexOnce({ db, src: chain, cfg, sleep: async () => undefined });
  const res = buildExport(db, cfg, { from: opts.from, to: opts.to, generatedAt: "2026-11-06T00:00:00.000Z" });
  db.close();
  chain.requests = [];
  return { csv: res.csv, metaText: JSON.stringify(res.meta, null, 2) + "\n", meta: res.meta };
}
