/** Column order from docs/lead/ledger.md. */
export const CSV_COLUMNS = ["date_utc", "source", "order_id", "merchant_id", "payer", "gross_usdt", "relay_fee_usdt", "refunded_usdt", "net_usdt", "status", "tx_hash", "block", "log_index"] as const;
import type { Issue } from "./types.js";

export type Column = (typeof CSV_COLUMNS)[number];
export const AMOUNT_COLUMNS = ["gross_usdt", "relay_fee_usdt", "refunded_usdt", "net_usdt"] as const;

export interface CsvRow {
  /** 1-based line number in the file (header is line 1). */
  line: number;
  cells: Record<Column, string>;
  block: number;
  logIndex: number;
  /** `tx_hash:log_index` */
  key: string;
}

/** Splits one CSV line with standard double-quote quoting. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur === "") quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const UINT = /^(0|[1-9]\d*)$/;
const SOURCES = new Set(["router", "payto_transfer"]);
const STATUSES = new Set(["settled", "partially_refunded", "refunded"]);

/**
 * Checks the file shape the indexer promises (ledger.md): exact header, `\n` endings with a trailing newline,
 * amounts with exactly `decimals` places, lowercase hex, integer block/log index, sorted by block then log index,
 * and no two rows with the same `tx_hash:log_index`. Returns the rows that parsed well enough to compare.
 */
export function checkStructure(text: string, decimals: number): { rows: CsvRow[]; issues: Issue[]; dataLines: number } {
  const issues: Issue[] = [];
  const add = (i: Omit<Issue, "check">) => issues.push({ check: "structure", ...i });
  const amount = new RegExp(`^(0|[1-9]\\d*)\\.\\d{${decimals}}$`);
  // net_usdt alone may be negative (the relay fee is not returned on a full refund); "-0.000000" is never valid.
  const netAmount = new RegExp(`^(0|-?[1-9]\\d*|-0(?=\\.\\d*[1-9]))\\.\\d{${decimals}}$`);

  if (text.includes("\r")) add({ code: "crlf_line_endings", message: "file contains \\r; the export uses \\n line endings only" });
  const body = text.replace(/\r/g, "");
  if (body.length > 0 && !body.endsWith("\n")) add({ code: "missing_trailing_newline", message: "the last line must end with \\n" });

  const lines = body.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const header = lines[0] ?? "";
  const expectedHeader = CSV_COLUMNS.join(",");
  if (header !== expectedHeader) {
    add({ code: "bad_header", line: 1, message: `header must be exactly "${expectedHeader}"`, expected: expectedHeader, actual: header });
  }

  const rows: CsvRow[] = [];
  const seen = new Map<string, number>();
  let prev: CsvRow | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = i + 1;
    const raw = lines[i]!;
    if (raw === "") {
      add({ code: "empty_line", line, message: "empty line inside the file" });
      continue;
    }
    const parts = parseCsvLine(raw);
    if (parts.length !== CSV_COLUMNS.length) {
      add({ code: "bad_cell_count", line, message: `expected ${CSV_COLUMNS.length} cells, found ${parts.length}`, actual: String(parts.length) });
      continue;
    }
    const cells = Object.fromEntries(CSV_COLUMNS.map((c, j) => [c, parts[j]!])) as Record<Column, string>;
    const bad = (code: Issue["code"], field: Column, why: string) =>
      add({ code, line, field, message: `${field} ${JSON.stringify(cells[field])} ${why}`, actual: cells[field] });

    if (!ISO.test(cells.date_utc) || Number.isNaN(Date.parse(cells.date_utc))) bad("bad_date", "date_utc", "is not ISO 8601 UTC (YYYY-MM-DDTHH:MM:SS.sssZ)");
    if (!SOURCES.has(cells.source)) bad("bad_source", "source", "is not router or payto_transfer");
    if (!STATUSES.has(cells.status)) bad("bad_status", "status", "is not settled, partially_refunded or refunded");
    for (const f of ["order_id", "merchant_id"] as const) {
      if (cells[f] !== "" && !HEX32.test(cells[f])) bad("bad_hex", f, "is not empty or a lowercase 32-byte hex value");
    }
    if (!ADDR.test(cells.payer)) bad("bad_hex", "payer", "is not a lowercase address");
    if (!HEX32.test(cells.tx_hash)) bad("bad_hex", "tx_hash", "is not a lowercase 32-byte hash");
    for (const f of AMOUNT_COLUMNS) {
      if (!(f === "net_usdt" ? netAmount : amount).test(cells[f])) bad("bad_amount", f, `is not a decimal with exactly ${decimals} places`);
    }
    let intsOk = true;
    for (const f of ["block", "log_index"] as const) {
      if (!UINT.test(cells[f])) {
        bad("bad_integer", f, "is not a non-negative integer");
        intsOk = false;
      }
    }
    if (!intsOk) continue;

    const row: CsvRow = { line, cells, block: Number(cells.block), logIndex: Number(cells.log_index), key: `${cells.tx_hash}:${cells.log_index}` };
    const dup = seen.get(row.key);
    if (dup !== undefined) {
      add({ code: "duplicate_row", line, key: row.key, message: `duplicate tx_hash:log_index ${row.key} (first seen on line ${dup})` });
      continue;
    }
    seen.set(row.key, line);
    if (prev && (row.block < prev.block || (row.block === prev.block && row.logIndex <= prev.logIndex))) {
      add({ code: "not_sorted", line, key: row.key, message: `row (block ${row.block}, log ${row.logIndex}) comes after (block ${prev.block}, log ${prev.logIndex}); rows must be sorted by block then log index` });
    }
    prev = row;
    rows.push(row);
  }
  return { rows, issues, dataLines: Math.max(0, lines.length - 1) };
}
