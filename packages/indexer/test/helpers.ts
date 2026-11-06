import type { Hex } from "viem";
import type { Scope, ChainReader, Block, ChainEvent } from "../src/model.js";
import { IndexDb } from "../src/db.js";
import { Indexer } from "../src/indexer.js";
export const hash = (n: number) =>
  ("0x" + n.toString(16).padStart(64, "0")) as Hex;
export const address = (n: number) =>
  ("0x" + n.toString(16).padStart(40, "0")) as Hex;
export const MERCHANT = hash(101),
  OTHER = hash(102),
  ORDER = hash(201),
  PAYER = address(1),
  PAYOUT = address(2);
export const scope: Scope = {
  chainId: 1874,
  router: address(3),
  token: address(4),
  deploymentBlock: 1,
  confirmations: 2,
};
export class FakeReader implements ChainReader {
  head = 12;
  chainId = 1874;
  epoch = 0;
  forkAt = Number.MAX_SAFE_INTEGER;
  events: ChainEvent[] = [];
  pages: { from: number; to: number }[] = [];
  failAt: number | undefined;
  duplicate = false;
  async getChainId() {
    return this.chainId;
  }
  async getHead() {
    return this.head;
  }
  async getBlock(number: number): Promise<Block> {
    if (number > this.head || number < 0) throw new Error("Block unavailable");
    return {
      number,
      hash: hash(
        number + 1000 + (number >= this.forkAt ? this.epoch * 1_000_000 : 0),
      ),
      timestamp: 1_800_000_000 + number,
    };
  }
  async location(blockNumber: number, logIndex = 0) {
    return {
      blockNumber,
      blockHash: (await this.getBlock(blockNumber)).hash,
      txHash: hash(
        blockNumber * 100 + logIndex + 10000 + this.epoch * 1_000_000,
      ),
      logIndex,
    };
  }
  async paid(block = 2, merchantId = MERCHANT, orderId = ORDER) {
    const event: ChainEvent = {
      ...(await this.location(block)),
      type: "Paid",
      merchantId,
      orderId,
      payer: PAYER,
      payout: PAYOUT,
      value: "25000000",
      fee: "50000",
      relayer: address(5),
    };
    this.events.push(event);
    return event;
  }
  async refund(
    block = 4,
    amount = "5000000",
    totalRefunded = amount,
    refundIndex = "0",
  ) {
    const event: ChainEvent = {
      ...(await this.location(block)),
      type: "Refunded",
      merchantId: MERCHANT,
      orderId: ORDER,
      payer: PAYER,
      amount,
      totalRefunded,
      refundIndex,
    };
    this.events.push(event);
    return event;
  }
  async getEvents(from: number, to: number) {
    this.pages.push({ from, to });
    if (this.failAt !== undefined && from <= this.failAt && to >= this.failAt)
      throw new Error("RPC unavailable");
    const rows = this.events.filter(
      (e) => e.blockNumber >= from && e.blockNumber <= to,
    );
    return this.duplicate ? [...rows, ...rows] : rows;
  }
  async reorg(at: number) {
    this.forkAt = at;
    this.epoch++;
    this.events = this.events.filter((e) => e.blockNumber < at);
  }
}
export function makeEnv(pageSize = 3, maxPages = 20) {
  const chain = new FakeReader(),
    db = new IndexDb(":memory:", scope),
    indexer = new Indexer(db, chain, scope, pageSize, maxPages);
  return { chain, db, indexer };
}
