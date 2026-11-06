import { expect, it } from "vitest";
import { agentPayments, decimalToBase, parseCsv, totalBase } from "../src/lib/ledger-csv";

const H = "date_utc,source,order_id,merchant_id,payer,gross_usdt,relay_fee_usdt,refunded_usdt,net_usdt,status,tx_hash,block,log_index";
const TX = "0x" + "ab".repeat(32);
const row = (src: string, gross: string, tx = TX, payer = "0x1111111111111111111111111111111111111111") =>
  `2026-01-01 10:00:00,${src},,m1,${payer},${gross},0,0,${gross},settled,${tx},5,1`;

it("parses quotes, embedded commas, escaped quotes, newlines and CRLF", () => {
  expect(parseCsv('a,"b,c","d ""q"""\r\n"x\ny",,z\r\n')).toEqual([["a", "b,c", 'd "q"'], ["x\ny", "", "z"]]);
});
it("handles empty input and blank lines", () => {
  expect(parseCsv("")).toEqual([]);
  expect(parseCsv("\n\n")).toEqual([]);
  expect(agentPayments("")).toEqual([]);
  expect(agentPayments(H + "\n")).toEqual([]);
});
it("filters x402 rows and totals exactly in bigint", () => {
  const csv = [H, row("order", "9"), row("x402", "0.000001"), row("x402", "12345678901234567.123457"), row("x402", "bad")].join("\r\n");
  const ps = agentPayments(csv);
  expect(ps).toHaveLength(2);
  expect(totalBase(ps)).toBe(1n + 12345678901234567123457n);
  expect(ps[0]!.explorerUrl).toBe(`https://explorer.testnet.whitechain.io/tx/${TX}`);
});
it("rejects a malformed tx hash as a link and handles quoted payer", () => {
  const ps = agentPayments([H, row("x402", "1", "javascript:alert(1)", '"0xabc"')].join("\n"));
  expect(ps[0]!.explorerUrl).toBeNull();
  expect(ps[0]!.payer).toBe("0xabc");
});
it("returns nothing when required columns are missing", () => {
  expect(agentPayments("a,b\n1,2")).toEqual([]);
});
it("decimalToBase is exact and strict", () => {
  expect(decimalToBase("5")).toBe(5000000n);
  expect(decimalToBase("0.1234567")).toBeNull();
  expect(decimalToBase("-1")).toBeNull();
  expect(decimalToBase("")).toBeNull();
});
