import { CSV_COLUMNS, type LedgerRow } from "./ledger.js";
const escape = (value: string) =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
export function writeCsv(rows: LedgerRow[]): string {
  return (
    [
      CSV_COLUMNS.join(","),
      ...rows.map((row) => CSV_COLUMNS.map((c) => escape(row[c])).join(",")),
    ].join("\r\n") + "\r\n"
  );
}
/** Strict RFC-style CSV reader; retains arbitrary cells so tampering can be reported by field. */
export function readCsv(input: string): LedgerRow[] {
  const text = input.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [],
    value = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
      continue;
    }
    if (c === '"') {
      if (value || closed) throw new Error("Unexpected CSV quote");
      quoted = true;
      continue;
    }
    if (c === ",") {
      record.push(value);
      value = "";
      closed = false;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(value);
      records.push(record);
      record = [];
      value = "";
      closed = false;
      continue;
    }
    if (closed) throw new Error("Text after closing CSV quote");
    value += c;
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  if (value || record.length || closed) {
    record.push(value);
    records.push(record);
  }
  const header = records.shift();
  if (
    !header ||
    header.length !== CSV_COLUMNS.length ||
    !header.every((v, i) => v === CSV_COLUMNS[i])
  )
    throw new Error("Unexpected CSV columns");
  return records.map((fields, i) => {
    if (fields.length !== CSV_COLUMNS.length)
      throw new Error(`Invalid CSV row ${i + 2}`);
    return Object.fromEntries(
      CSV_COLUMNS.map((c, i) => [c, fields[i]!]),
    ) as LedgerRow;
  });
}
