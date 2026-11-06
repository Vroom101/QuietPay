import { describe, expect, it } from "vitest";
import { buildLedgerRows, decodeRouterLog, decodeTransferLog, formatAmount, toCsv, CSV_COLUMNS } from "../src/index.js";
import type { ChainLog, RawEvent } from "../src/types.js";
import { MERCHANT, PAYER, PAYTO, ROUTER, T0, USDT, order, paidLog, refundedLog, transferLog, txHash } from "./fake.js";

function raw(log: ChainLog): RawEvent {
  const d = decodeRouterLog(log) ?? decodeTransferLog(log)!;
  return {
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    block: log.blockNumber,
    blockHash: log.blockHash,
    timestamp: T0 + log.blockNumber,
    address: log.address,
    kind: d.kind,
    args: d.args,
  };
}
const cfg = { router: ROUTER, facilitatorPayTo: PAYTO };

describe("router rows", () => {
  it("1. a Paid log becomes one router row with the right gross, fee, net and status", () => {
    const rows = buildLedgerRows([raw(paidLog({ block: 200, orderId: order(1), value: 25_000_000n, fee: 50_000n }))], cfg);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "router",
      grossUsdt: "25.000000",
      relayFeeUsdt: "0.050000",
      refundedUsdt: "0.000000",
      netUsdt: "24.950000",
      status: "settled",
      orderId: order(1),
      merchantId: MERCHANT,
      payer: PAYER,
      block: 200,
    });
    expect(rows[0]!.dateUtc).toBe(new Date((T0 + 200) * 1000).toISOString());
  });

  it("2. Paid then two Refunded logs update one row; last status and amounts are right", () => {
    const rows = buildLedgerRows(
      [
        raw(paidLog({ block: 200, orderId: order(1), value: 25_000_000n, fee: 50_000n })),
        raw(refundedLog({ block: 210, orderId: order(1), amount: 5_000_000n, total: 5_000_000n, index: 0 })),
        raw(refundedLog({ block: 220, orderId: order(1), amount: 3_000_000n, total: 8_000_000n, index: 1 })),
      ],
      cfg,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refundedUsdt: "8.000000", netUsdt: "16.950000", status: "partially_refunded", block: 200 });
  });

  it("3. a full refund gives status refunded and net zero", () => {
    const rows = buildLedgerRows(
      [
        raw(paidLog({ block: 200, orderId: order(1), value: 25_000_000n, fee: 50_000n })),
        raw(refundedLog({ block: 210, orderId: order(1), amount: 10_000_000n, total: 10_000_000n, index: 0 })),
        raw(refundedLog({ block: 220, orderId: order(1), amount: 15_000_000n, total: 25_000_000n, index: 1 })),
      ],
      cfg,
    );
    expect(rows[0]).toMatchObject({ status: "refunded", refundedUsdt: "25.000000", netUsdt: "0.000000" });
  });

  it("is independent of input order", () => {
    const evs = [
      raw(paidLog({ block: 200, orderId: order(1), value: 25_000_000n, fee: 50_000n })),
      raw(refundedLog({ block: 210, orderId: order(1), amount: 1n, total: 1n, index: 0 })),
      raw(paidLog({ block: 205, orderId: order(2), value: 1_000_000n, fee: 0n })),
    ];
    expect(buildLedgerRows([...evs].reverse(), cfg)).toEqual(buildLedgerRows(evs, cfg));
  });
});

describe("x402 rows", () => {
  it("4. a direct Transfer to the facilitator becomes one x402 row", () => {
    const rows = buildLedgerRows([raw(transferLog({ block: 300, from: PAYER, to: PAYTO, value: 1_500_000n }))], cfg);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "x402",
      orderId: "",
      merchantId: "",
      payer: PAYER,
      grossUsdt: "1.500000",
      relayFeeUsdt: "0.000000",
      refundedUsdt: "0.000000",
      netUsdt: "1.500000",
      status: "settled",
    });
  });

  it("5. a router payment whose payout equals the facilitator is counted once, as router", () => {
    const tx = txHash();
    const rows = buildLedgerRows(
      [
        // The router pays the merchant (= facilitator address): Transfer(router -> payTo) in the same tx as Paid.
        raw(transferLog({ block: 200, tx, logIndex: 1, from: ROUTER, to: PAYTO, value: 24_950_000n })),
        raw(paidLog({ block: 200, tx, logIndex: 3, orderId: order(1), value: 25_000_000n, fee: 50_000n, payout: PAYTO })),
      ],
      cfg,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("router");
  });

  it("excludes a Transfer from the router, and any Transfer sharing a tx with a router Paid/Refunded", () => {
    const tx = txHash();
    const rows = buildLedgerRows(
      [
        raw(paidLog({ block: 200, tx, logIndex: 3, orderId: order(1), value: 25_000_000n, fee: 0n })),
        raw(transferLog({ block: 200, tx, logIndex: 1, from: PAYER, to: PAYTO, value: 5n })), // same tx as router log
        raw(transferLog({ block: 201, from: ROUTER, to: PAYTO, value: 7n })), // from the router, different tx
        raw(transferLog({ block: 202, from: PAYER, to: PAYTO, value: 9n })), // genuine agent payment
      ],
      cfg,
    );
    expect(rows.map((r) => r.source)).toEqual(["router", "x402"]);
    expect(rows[1]!.grossUsdt).toBe("0.000009");
  });

  it("ignores transfers to other addresses and does nothing without a facilitator address", () => {
    const evs = [raw(transferLog({ block: 300, from: PAYER, to: "0x9999999999999999999999999999999999999999", value: 5n }))];
    expect(buildLedgerRows(evs, cfg)).toHaveLength(0);
    expect(buildLedgerRows([raw(transferLog({ block: 300, from: PAYER, to: PAYTO, value: 5n }))], { router: ROUTER })).toHaveLength(0);
  });
});

describe("formatting and csv", () => {
  it("11. base units render with exactly 6 places", () => {
    expect(formatAmount(1n)).toBe("0.000001");
    expect(formatAmount(999_999n)).toBe("0.999999");
    expect(formatAmount(1_000_000n)).toBe("1.000000");
    expect(formatAmount(0n)).toBe("0.000000");
    expect(formatAmount(123_456_789_012n)).toBe("123456.789012");
  });

  it("emits the frozen columns in order, sorted by block then log index, with \\n endings", () => {
    const rows = buildLedgerRows(
      [
        raw(transferLog({ block: 300, logIndex: 2, from: PAYER, to: PAYTO, value: 1n })),
        raw(paidLog({ block: 200, orderId: order(1), value: 2_000_000n, fee: 0n })),
        raw(transferLog({ block: 300, logIndex: 1, from: PAYER, to: PAYTO, value: 2n })),
      ],
      cfg,
    );
    const csv = toCsv(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(CSV_COLUMNS.join(",")).toBe(
      "date_utc,source,order_id,merchant_id,payer,gross_usdt,relay_fee_usdt,refunded_usdt,net_usdt,status,tx_hash,block,log_index",
    );
    expect(lines.slice(1, 4).map((l) => l.split(",")[11] + ":" + l.split(",")[12])).toEqual(["200:0", "300:1", "300:2"]);
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv).not.toContain("\r");
    // every column filled for a router row, and the x402 row has empty order/merchant
    expect(lines[1]!.split(",").every((c) => c !== "")).toBe(true);
    expect(lines[2]!.split(",").slice(2, 4)).toEqual(["", ""]);
  });

  it("quotes cells that contain commas, quotes or newlines", () => {
    const [row] = buildLedgerRows([raw(paidLog({ block: 1, orderId: order(1), value: 1n, fee: 0n }))], cfg);
    expect(toCsv([{ ...row!, orderId: 'a,"b"' }])).toContain('"a,""b"""');
  });
});

void USDT;

describe("decimals come from the token, not a hardcoded 6", () => {
  it("formats with the token decimals by default and honours an 18-decimal token", () => {
    expect(formatAmount(1n)).toBe("0.000001"); // token.json says 6
    expect(formatAmount(1n, 18)).toBe("0.000000000000000001");
    expect(formatAmount(5n, 0)).toBe("5");
    const rows = buildLedgerRows([raw(paidLog({ block: 1, orderId: order(1), value: 25_000_000_000_000_000_000n, fee: 0n }))], { router: ROUTER, decimals: 18 });
    expect(rows[0]!.grossUsdt).toBe("25.000000000000000000");
    expect(rows[0]!.refundedUsdt).toBe("0.000000000000000000");
  });
});
