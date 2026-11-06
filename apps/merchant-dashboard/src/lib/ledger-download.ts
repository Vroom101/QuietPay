/** Client for the store's GET /api/merchant/ledger/export (the on-chain ledger CSV + its verification metadata). */
export interface LedgerExport {
  csv: string;
  meta: { fromBlock?: number; toBlock?: number; confirmations?: number; layout?: string; [k: string]: unknown };
}

export class LedgerDownloadError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export async function fetchLedgerExport(opts: { merchantUrl: string; token: string; fetch?: typeof fetch }): Promise<LedgerExport> {
  if (!opts.token) throw new LedgerDownloadError("Sign in to download the ledger.", "unauthorized");
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${opts.merchantUrl.replace(/\/+$/, "")}/ledger/export`, { headers: { authorization: `Bearer ${opts.token}` } });
  } catch {
    throw new LedgerDownloadError("The merchant server is not reachable.", "network");
  }
  const body = (await res.json().catch(() => undefined)) as { csv?: unknown; meta?: unknown; error?: { code?: string; message?: string } } | undefined;
  if (!res.ok) {
    const msg = body?.error?.message ?? `Ledger export failed (${res.status}).`;
    throw new LedgerDownloadError(res.status === 401 ? "Your session expired. Sign in again to download the ledger." : msg, body?.error?.code);
  }
  if (typeof body?.csv !== "string" || !body.meta || typeof body.meta !== "object") throw new LedgerDownloadError("The ledger export was malformed.", "malformed");
  return { csv: body.csv, meta: body.meta as LedgerExport["meta"] };
}

/** Rows in the CSV, header excluded. */
export const ledgerRowCount = (csv: string) => Math.max(0, csv.split("\n").filter((l) => l.trim()).length - 1);
