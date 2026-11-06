/**
 * Builds deliberately broken copies of a clean export, for the demo video and for tests. Pure string functions:
 * they never touch the chain. Each variant names the issue code the verifier is expected to raise.
 */
import { CSV_COLUMNS } from "./csv.js";

export interface TamperedSample {
  name: "changed-row" | "deleted-row" | "range-truncated";
  csv: string;
  meta: string;
  /** Issue code the verifier must report. */
  expect: "wrong_amount" | "missing_row" | "range_mismatch";
  /** Extra verifier flags needed to see it (the truncation needs the expected range from outside the file). */
  verifierArgs: string[];
  note: string;
}

function parts(csv: string) {
  const lines = csv.split("\n");
  const trailing = lines.at(-1) === "" ? "\n" : "";
  const body = trailing ? lines.slice(0, -1) : lines;
  return { header: body[0]!, rows: body.slice(1), trailing };
}

/** Raises gross_usdt of the first data row by exactly one whole unit; the row stays well-formed. */
export function changeFirstRowAmount(csv: string): string {
  const { header, rows, trailing } = parts(csv);
  if (rows.length === 0) throw new Error("export has no data rows to change");
  const col = CSV_COLUMNS.indexOf("gross_usdt");
  const cells = rows[0]!.split(",");
  const [whole, frac] = cells[col]!.split(".");
  cells[col] = `${BigInt(whole!) + 1n}.${frac}`;
  return [header, cells.join(","), ...rows.slice(1)].join("\n") + trailing;
}

export function deleteFirstRow(csv: string): string {
  const { header, rows, trailing } = parts(csv);
  if (rows.length === 0) throw new Error("export has no data rows to delete");
  return [header, ...rows.slice(1)].join("\n") + trailing;
}

/** Drops every row after the first and pulls toBlock in to just past it, as a forger hiding later payments would. */
export function truncateRange(csv: string, metaText: string): { csv: string; meta: string } {
  const { header, rows, trailing } = parts(csv);
  if (rows.length < 2) throw new Error("need at least two rows to truncate");
  const meta = JSON.parse(metaText) as { toBlock: number };
  const blockCol = CSV_COLUMNS.indexOf("block");
  const keepUntil = Number(rows[0]!.split(",")[blockCol]);
  return {
    csv: [header, rows[0]!].join("\n") + trailing,
    meta: JSON.stringify({ ...meta, toBlock: keepUntil }, null, 2) + "\n",
  };
}

export function makeTamperedSamples(csv: string, metaText: string): TamperedSample[] {
  const meta = JSON.parse(metaText) as { fromBlock: number; toBlock: number };
  const out: TamperedSample[] = [
    {
      name: "changed-row",
      csv: changeFirstRowAmount(csv),
      meta: metaText,
      expect: "wrong_amount",
      verifierArgs: [],
      note: "gross_usdt of the first row raised by 1 USDT",
    },
    {
      name: "deleted-row",
      csv: deleteFirstRow(csv),
      meta: metaText,
      expect: "missing_row",
      verifierArgs: [],
      note: "first row removed, sidecar untouched",
    },
  ];
  if (parts(csv).rows.length >= 2) {
    const t = truncateRange(csv, metaText);
    out.push({
      name: "range-truncated",
      csv: t.csv,
      meta: t.meta,
      expect: "range_mismatch",
      verifierArgs: ["--from", String(meta.fromBlock), "--to", String(meta.toBlock)],
      note: "later rows dropped and toBlock pulled in; only caught because the expected range is passed from outside",
    });
  }
  return out;
}
