import { describe, expect, it } from "vitest";
import { verifyLedger } from "../src/index.js";
import { makeTamperedSamples, changeFirstRowAmount, deleteFirstRow, truncateRange } from "../src/tamper.js";
import { PAYTO, ROUTER, USDT, exportWithIndexer, scenario } from "./fake.js";

describe("tampered demo samples are caught with the expected class", () => {
  it("changed-row, deleted-row and range-truncated each fail with their code, and the clean file passes", async () => {
    const chain = scenario();
    const { csv, metaText, meta } = await exportWithIndexer(chain);
    const verify = (c: string, m: string, expected?: { fromBlock: number; toBlock: number }) =>
      verifyLedger({ csvText: c, metaText: m, src: chain, router: ROUTER, usdt: USDT, expectedPayTo: PAYTO, expected, sleep: async () => undefined });
    expect((await verify(csv, metaText, { fromBlock: meta.fromBlock, toBlock: meta.toBlock })).ok).toBe(true);

    const samples = makeTamperedSamples(csv, metaText);
    expect(samples.map((s) => s.name)).toEqual(["changed-row", "deleted-row", "range-truncated"]);
    for (const s of samples) {
      const expected = s.verifierArgs.length ? { fromBlock: meta.fromBlock, toBlock: meta.toBlock } : undefined;
      const r = await verify(s.csv, s.meta, expected);
      expect(r.ok, s.name).toBe(false);
      expect(r.issues.map((i) => i.code), s.name).toContain(s.expect);
    }
  });

  it("the changed row is flagged exactly: one field, one row", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain);
    const r = await verifyLedger({ csvText: changeFirstRowAmount(csv), metaText, src: chain, router: ROUTER, usdt: USDT, expectedPayTo: PAYTO, sleep: async () => undefined });
    const rowIssues = r.issues.filter((i) => i.check === "rows");
    expect(rowIssues).toHaveLength(1);
    expect(rowIssues[0]).toMatchObject({ code: "wrong_amount", field: "gross_usdt", line: 2 });
  });

  it("the deleted row is reported missing, once", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain);
    const r = await verifyLedger({ csvText: deleteFirstRow(csv), metaText, src: chain, router: ROUTER, usdt: USDT, expectedPayTo: PAYTO, sleep: async () => undefined });
    expect(r.issues.filter((i) => i.code === "missing_row")).toHaveLength(1);
  });

  it("refuses to tamper with an export that has nothing to tamper with", async () => {
    const chain = scenario();
    const { metaText } = await exportWithIndexer(chain);
    const header = "date_utc,source,order_id,merchant_id,payer,gross_usdt,relay_fee_usdt,refunded_usdt,net_usdt,status,tx_hash,block,log_index\n";
    expect(() => changeFirstRowAmount(header)).toThrow();
    expect(() => deleteFirstRow(header)).toThrow();
    expect(() => truncateRange(header, metaText)).toThrow();
  });
});
