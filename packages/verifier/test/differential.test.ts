import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildLedgerRows, decodeRouterLog, decodeTransferLog, eventSetHash, type RawEvent } from "@quietpay/indexer";
import { PAYTO, ROUTER, USDT, MERCHANT, PAYER, PAYOUT, RELAYER, order, tx, merchantRegistered, payment, refund, transfer } from "./fake.js";
import { amountText, decodeRouter, decodeTransfer, deriveRows, eventSetDigest, type SpecEvent } from "../src/spec.js";

const hex40 = fc.integer({ min: 1, max: 6 }).map((n) => "0x" + n.toString(16).padStart(40, "0"));
const hex64 = (max: number) => fc.integer({ min: 1, max }).map((n) => "0x" + n.toString(16).padStart(64, "0"));
const amount = fc.bigInt({ min: 1n, max: 2n ** 70n });

/** Random but internally plausible event sets, including duplicates, refunds before payments and odd orderings. */
const eventsArb = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("Paid" as const),
      merchantId: hex64(2),
      orderId: hex64(4),
      payer: hex40,
      value: amount,
      fee: fc.bigInt({ min: 0n, max: 2n ** 40n }),
    }),
    fc.record({ kind: fc.constant("Refunded" as const), merchantId: hex64(2), orderId: hex64(4), total: amount }),
    fc.record({ kind: fc.constant("Transfer" as const), from: fc.oneof(hex40, fc.constant(ROUTER)), to: fc.oneof(hex40, fc.constant(PAYTO)), value: amount }),
    fc.record({ kind: fc.constant("RelayerSet" as const) }),
  ),
  { maxLength: 30 },
).chain((items) =>
  fc.tuple(
    fc.constant(items),
    fc.array(fc.integer({ min: 1, max: 8 }), { minLength: items.length, maxLength: items.length }),
    fc.array(fc.integer({ min: 0, max: 5 }), { minLength: items.length, maxLength: items.length }),
  ),
);

function toEvents(items: any[], tail: number[], tx0: number[]): { raw: RawEvent[]; spec: SpecEvent[] } {
  const raw: RawEvent[] = [];
  const spec: SpecEvent[] = [];
  items.forEach((it, i) => {
    const block = 100 + i * 2 + (tail[i]! % 2);
    const txHash = tx(1 + (tx0[i]! % 4) + (i % 3) * 10);
    const base = { txHash, logIndex: i, block, blockHash: tx(block), timestamp: 1_800_000_000 + block * 3 };
    let args: Record<string, string> = {};
    let address = ROUTER;
    if (it.kind === "Paid") args = { merchantId: it.merchantId, orderId: it.orderId, payer: it.payer, payout: PAYOUT, value: String(it.value), fee: String(it.fee), relayer: RELAYER };
    else if (it.kind === "Refunded") args = { merchantId: it.merchantId, orderId: it.orderId, payer: PAYER, amount: "1", totalRefunded: String(it.total), refundIndex: "0" };
    else if (it.kind === "Transfer") {
      address = USDT;
      args = { from: it.from, to: it.to, value: String(it.value) };
    }
    raw.push({ ...base, address, kind: it.kind, args });
    spec.push({ txHash, logIndex: i, block, timestamp: base.timestamp, address, kind: it.kind, args });
  });
  return { raw, spec };
}

describe("differential: the verifier's own rules agree with the indexer's", () => {
  it("derives identical rows from random event sets", () => {
    fc.assert(
      fc.property(eventsArb, ([items, tail, tx0]) => {
        const { raw, spec } = toEvents(items, tail, tx0);
        for (const payTo of [undefined, PAYTO]) {
          const a = buildLedgerRows(raw, { router: ROUTER, facilitatorPayTo: payTo, decimals: 6 });
          const b = deriveRows(spec, { router: ROUTER, payTo, decimals: 6 });
          expect(b.map((r) => [r.dateUtc, r.source, r.orderId, r.merchantId, r.payer, r.gross, r.fee, r.refunded, r.net, r.status, r.txHash, r.block, r.logIndex])).toEqual(
            a.map((r) => [r.dateUtc, r.source, r.orderId, r.merchantId, r.payer, r.grossUsdt, r.relayFeeUsdt, r.refundedUsdt, r.netUsdt, r.status, r.txHash, r.block, r.logIndex]),
          );
        }
      }),
      { numRuns: 400 },
    );
  });

  it("hashes the same event set the same way, in any order", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(hex64(50), fc.integer({ min: 0, max: 20 })), { maxLength: 25 }), (pairs) => {
        const ev = pairs.map(([t, i]) => ({ txHash: t, logIndex: i }));
        expect(eventSetDigest(ev)).toBe(eventSetHash(ev));
        expect(eventSetDigest([...ev].reverse())).toBe(eventSetHash(ev));
      }),
    );
  });

  it("formats amounts like the indexer for any size", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 200n }), fc.integer({ min: 0, max: 18 }), (v, d) => {
        const s = amountText(v, d);
        expect(s).toMatch(d === 0 ? /^\d+$/ : new RegExp(`^\\d+\\.\\d{${d}}$`));
        expect(BigInt(s.replace(".", ""))).toBe(v);
      }),
    );
  });
});

describe("differential: raw log decoding", () => {
  const logs = [
    merchantRegistered(100, tx(0xa0)),
    ...payment({ block: 150, tx: tx(1), orderId: order(1), value: 25_000_000n, fee: 50_000n }),
    ...refund({ block: 160, tx: tx(2), orderId: order(1), amount: 5_000_000n, total: 5_000_000n, index: 0 }),
    transfer(180, tx(4), 0, PAYER, PAYTO, 1_500_000n),
  ];
  it("decodes every real log exactly like the indexer's ABI decoder", () => {
    for (const l of logs) {
      const a = l.address === ROUTER ? decodeRouterLog(l) : decodeTransferLog(l);
      const b = l.address === ROUTER ? decodeRouter(l) : decodeTransfer(l);
      expect(b?.kind).toBe(a?.kind);
      if (a?.kind === "Paid" || a?.kind === "Refunded" || a?.kind === "Transfer") expect(b?.args).toEqual(a.args);
    }
  });

  it("rejects an ERC-721 style Transfer, a short data field and a foreign topic", () => {
    const t = transfer(180, tx(4), 0, PAYER, PAYTO, 1n);
    expect(decodeTransfer({ ...t, topics: [...t.topics, t.topics[1]!] })).toBeNull();
    expect(decodeTransfer({ ...t, data: "0x01" })).toBeNull();
    expect(decodeTransfer({ ...t, topics: ["0x" + "00".repeat(32), ...t.topics.slice(1)] })).toBeNull();
    const p = payment({ block: 1, tx: tx(9), orderId: order(1), value: 5n, fee: 0n }).at(-1)!;
    expect(decodeRouter({ ...p, data: p.data.slice(0, -64) })).toBeNull();
    expect(decodeRouter({ ...p, topics: p.topics.slice(0, 3) })).toBeNull();
    expect(MERCHANT).toBeTruthy();
  });
});

describe("net on a full refund is negative by the relay fee (decision: merchant view)", () => {
  const ev = (kind: "Paid" | "Refunded", logIndex: number, args: Record<string, string>): SpecEvent => ({ txHash: tx(logIndex + 1), logIndex, block: 100 + logIndex, timestamp: 1_800_000_000, address: ROUTER, kind, args });
  const paid = ev("Paid", 0, { merchantId: order(1), orderId: order(2), payer: PAYER, payout: PAYOUT, value: "1000000", fee: "50000", relayer: RELAYER });
  const full = ev("Refunded", 1, { merchantId: order(1), orderId: order(2), payer: PAYER, amount: "1000000", totalRefunded: "1000000", refundIndex: "0" });
  it("spec and indexer both give -0.050000 and status refunded", () => {
    const s = deriveRows([paid, full], { router: ROUTER, decimals: 6 })[0]!;
    expect([s.net, s.status]).toEqual(["-0.050000", "refunded"]);
    const raw: RawEvent[] = [paid, full].map((e) => ({ ...e, blockHash: tx(e.block) }));
    const i = buildLedgerRows(raw, { router: ROUTER, decimals: 6 })[0]!;
    expect([i.netUsdt, i.status]).toEqual(["-0.050000", "refunded"]);
  });
  it("a partial refund below value - fee stays positive", () => {
    const part = ev("Refunded", 1, { ...full.args, amount: "500000", totalRefunded: "500000" });
    expect(deriveRows([paid, part], { router: ROUTER, decimals: 6 })[0]!.net).toBe("0.450000");
  });
});
