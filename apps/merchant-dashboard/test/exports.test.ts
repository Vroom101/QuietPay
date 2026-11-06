import { describe, expect, it } from "vitest";
import { buildTransactionsCsv, csvCell, formatWbt } from "../src/lib/csv";
import { fetchLedgerExport, ledgerRowCount, LedgerDownloadError } from "../src/lib/ledger-download";
import { buildMetrics } from "../src/DashboardMetrics";
import type { DashboardOrder } from "../src/lib/view";

const CHECKOUT = { chainId: 1874, token: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" } as never;
let n = 0;
const order = (o: Partial<DashboardOrder> & Pick<DashboardOrder, "status" | "amount">): DashboardOrder => ({
  id: "0x" + (++n).toString(16).padStart(64, "0"), fee: "50000", createdAt: 1_800_000_000, settledAt: 1_800_000_010,
  refunded: "0", refundCount: 0, checkout: CHECKOUT, ...o,
}) as DashboardOrder;

describe("formatWbt", () => {
  it("is exact and trims zeros", () => {
    expect(formatWbt(0n)).toBe("0");
    expect(formatWbt(10n ** 18n)).toBe("1");
    expect(formatWbt("123456789012345")).toBe("0.00012345");
    expect(formatWbt("123456789012345", 18)).toBe("0.000123456789012345");
    expect(formatWbt(-(10n ** 17n))).toBe("-0.1");
  });
});

describe("csvCell defuses spreadsheet formulas", () => {
  it.each([["=HYPERLINK(1)", "'=HYPERLINK(1)"], ["+1", "'+1"], ["@SUM", "'@SUM"], ["-cmd", "'-cmd"], ["\tx", "'\tx"]])("%s", (i, o) => expect(csvCell(i)).toBe(o));
  it("keeps negative numbers numeric and quotes separators", () => {
    expect(csvCell("-0.500000")).toBe("-0.500000");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
  });
});

describe("transactions CSV", () => {
  const paid = order({ status: "settled", amount: "8500000", gasWei: "210000000000000", reference: "=evil()" });
  const refunded = order({ status: "refunded", amount: "8500000", refunded: "8500000", refundCount: 2, gasWei: "500000000000000" });
  const open = order({ status: "created", amount: "1000000", settledAt: undefined });

  it("has exact amounts, net with the fee kept on refunds, and no gas column unless asked", () => {
    const lines = buildTransactionsCsv([paid, refunded, open], { includeGas: false }).trim().split("\n");
    expect(lines[0]).not.toContain("gas_wbt");
    expect(lines[1]).toContain(",'=evil(),settled,");
    expect(lines[1]).toContain(",8.500000,0.050000,0.000000,8.450000,0");
    expect(lines[2]).toContain(",8.500000,0.050000,8.500000,-0.050000,2");
    expect(lines[3]).toContain(",created,,1.000000,0.000000,0.000000,0.000000,0");
  });

  it("adds gas in WBT per order when the merchant ticks 'include gas fees'", () => {
    const lines = buildTransactionsCsv([paid, open], { includeGas: true }).trim().split("\n");
    expect(lines[0].endsWith(",gas_wbt")).toBe(true);
    expect(lines[1].endsWith(",0.00021")).toBe(true);
    expect(lines[2].endsWith(",")).toBe(true);
  });
});

describe("cost cards", () => {
  const by = (orders: DashboardOrder[], demo = false) => Object.fromEntries(buildMetrics(orders, demo).map((m) => [m.label, m]));
  it("sums relay fees over paid orders and gas over all orders", () => {
    const m = by([
      order({ status: "settled", amount: "8500000", gasWei: "1000000000000000" }),
      order({ status: "refunded", amount: "1000000", refunded: "1000000", gasWei: "2000000000000000" }),
      order({ status: "failed", amount: "1000000", settledAt: undefined, gasWei: "500000000000000" }),
    ]);
    expect(m["Relay fees paid"].value).toBe("0.100000");
    expect(m["Network gas covered"].value).toBe("0.0035");
    expect(m["Network gas covered"].unit).toBe("WBT");
  });
  it("says so when the relayer does not report gas, and hides cost cards in demo mode", () => {
    expect(by([order({ status: "settled", amount: "1" })])["Network gas covered"].value).toBe("—");
    expect(by([order({ status: "settled", amount: "1" })], true)["Relay fees paid"]).toBeUndefined();
  });
});

describe("ledger download client", () => {
  const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("returns csv + meta and sends the session token", async () => {
    let auth = "";
    const f = (async (_u: string, init: RequestInit) => { auth = new Headers(init.headers).get("authorization") ?? ""; return Response.json({ csv: "h\na\nb\n", meta: { fromBlock: 1, toBlock: 2 } }); }) as unknown as typeof fetch;
    const r = await fetchLedgerExport({ merchantUrl: "/api/merchant/", token: "tok", fetch: f });
    expect(auth).toBe("Bearer tok");
    expect(ledgerRowCount(r.csv)).toBe(2);
  });
  it("explains failures", async () => {
    await expect(fetchLedgerExport({ merchantUrl: "/x", token: "" })).rejects.toBeInstanceOf(LedgerDownloadError);
    await expect(fetchLedgerExport({ merchantUrl: "/x", token: "t", fetch: ok({ error: { code: "unauthorized" } }, 401) })).rejects.toThrow(/Sign in again/);
    await expect(fetchLedgerExport({ merchantUrl: "/x", token: "t", fetch: ok({ error: { code: "ledger_unavailable", message: "still syncing" } }, 503) })).rejects.toThrow(/still syncing/);
    await expect(fetchLedgerExport({ merchantUrl: "/x", token: "t", fetch: ok({ csv: 3 }) })).rejects.toThrow(/malformed/);
    await expect(fetchLedgerExport({ merchantUrl: "/x", token: "t", fetch: (async () => { throw new Error("x"); }) as unknown as typeof fetch })).rejects.toThrow(/not reachable/);
  });
});
