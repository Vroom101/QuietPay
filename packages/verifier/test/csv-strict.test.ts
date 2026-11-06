import { describe, expect, it } from "vitest";
import { checkStructure } from "../src/csv.js";
import { exportWithIndexer, scenario } from "./fake.js";

const COLS = ["date_utc", "source", "order_id", "merchant_id", "payer", "gross_usdt", "relay_fee_usdt", "refunded_usdt", "net_usdt", "status", "tx_hash", "block", "log_index"];
async function good() {
  const { csv } = await exportWithIndexer(scenario());
  return csv;
}
function withCell(csv: string, row: number, col: string, value: string) {
  const lines = csv.split("\n");
  const cells = lines[row]!.split(",");
  cells[COLS.indexOf(col)] = value;
  lines[row] = cells.join(",");
  return lines.join("\n");
}
const codes = (csv: string) => checkStructure(csv, 6).issues.map((i) => i.code);

describe("T1b: strict CSV", () => {
  it("accepts real exporter output (round trip)", async () => {
    expect(checkStructure(await good(), 6).issues).toEqual([]);
  });
  it("rejects any quote character", async () => {
    expect(codes(withCell(await good(), 1, "source", '"router"'))).toContain("quoted_cell");
  });
  it.each(["=1+1", "+1", "@SUM(A1)", "\t1"])("rejects a formula-style prefix %j in a text cell", async (p) => {
    expect(codes(withCell(await good(), 1, "payer", p))).toContain("formula_cell");
  });
  it("rejects a leading minus anywhere except net_usdt (where a negative net is legitimate)", async () => {
    const csv = await good();
    expect(codes(withCell(csv, 1, "order_id", "-1"))).toContain("formula_cell");
    expect(codes(withCell(csv, 1, "gross_usdt", "-1.000000"))).toContain("formula_cell");
    expect(codes(withCell(csv, 1, "net_usdt", "-0.050000"))).not.toContain("formula_cell");
  });
  it("rejects a control character inside a cell", async () => {
    expect(codes(withCell(await good(), 1, "payer", "0x\u0001ab"))).toContain("control_char");
  });
  it("an embedded newline cannot hide: it needs a quote and it splits the row", async () => {
    const c = codes(withCell(await good(), 1, "status", '"set\ntled"'));
    expect(c).toContain("quoted_cell");
    expect(c).toContain("bad_cell_count");
  });
});
