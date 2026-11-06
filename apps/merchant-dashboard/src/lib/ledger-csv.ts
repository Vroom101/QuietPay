import { safeHttpUrl } from "./view";

/** RFC 4180-ish parser: quoted cells, escaped quotes, commas and newlines inside quotes, CRLF. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let any = false;
  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    cell = "";
    any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') {
      quoted = true;
      any = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
      any = true;
    } else if (c === "\r") {
      if (text[i + 1] !== "\n") endRow();
    } else if (c === "\n") endRow();
    else {
      cell += c;
      any = true;
    }
  }
  if (any || cell !== "" || row.length) endRow();
  return rows;
}

export interface AgentPayment {
  date: string;
  payer: string;
  grossBase: bigint;
  txHash: string;
  explorerUrl: string | null;
}

const EXPLORER = "https://explorer.testnet.whitechain.io/tx/";

/** Parses a decimal USDT string ("1.5") to 6-dp base units without floats. Returns null if invalid. */
export function decimalToBase(s: string, decimals = 6): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m || (m[2]?.length ?? 0) > decimals) return null;
  return BigInt(m[1]! + (m[2] ?? "").padEnd(decimals, "0"));
}

export function agentPayments(csv: string): AgentPayment[] {
  const rows = parseCsv(csv);
  const header = rows[0]?.map((h) => h.trim());
  if (!header) return [];
  const col = (n: string) => header.indexOf(n);
  const d = col("date_utc");
  const s = col("source");
  const p = col("payer");
  const g = col("gross_usdt");
  const t = col("tx_hash");
  if (s < 0 || g < 0) return [];
  const out: AgentPayment[] = [];
  for (const r of rows.slice(1)) {
    if (r[s]?.trim() !== "x402") continue;
    const gross = decimalToBase(r[g] ?? "");
    if (gross === null) continue;
    const txHash = t < 0 ? "" : (r[t] ?? "").trim();
    out.push({
      date: d < 0 ? "" : (r[d] ?? ""),
      payer: p < 0 ? "" : (r[p] ?? ""),
      grossBase: gross,
      txHash,
      explorerUrl: /^0x[0-9a-fA-F]{64}$/.test(txHash) ? safeHttpUrl(EXPLORER + txHash) : null,
    });
  }
  return out;
}

export const totalBase = (ps: Pick<AgentPayment, "grossBase">[]) => ps.reduce((a, p) => a + p.grossBase, 0n);
