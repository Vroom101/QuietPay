import { useState } from "react";
import csvUrl from "./fixtures/synthetic-sample.csv?url";
import metadataUrl from "./fixtures/synthetic-sample.csv.meta.json?url";
import metadata from "./fixtures/synthetic-sample.csv.meta.json";
import { downloadText } from "./lib/csv";
import { fetchLedgerExport, ledgerRowCount, type LedgerExport as Ledger } from "./lib/ledger-download";

/**
 * The on-chain ledger (every PaymentRouter event for this merchant, read from the chain by the QuietPay indexer), as a
 * CSV plus the metadata the ledger service's verify call uses to re-derive it from the chain. Live mode fetches through the store server,
 * which holds the merchant API key.
 */
export function LedgerExport({ useFixtures, merchantUrl, token }: { useFixtures: boolean; merchantUrl?: string; token?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [last, setLast] = useState<Ledger | null>(null);
  const live = !useFixtures && !!merchantUrl;

  async function download() {
    if (!merchantUrl) return;
    setBusy(true);
    setError("");
    try {
      const ledger = await fetchLedgerExport({ merchantUrl, token: token ?? "" });
      const name = `quietpay-ledger-${ledger.meta.fromBlock ?? "start"}-${ledger.meta.toBlock ?? "head"}`;
      downloadText(`${name}.csv`, ledger.csv);
      downloadText(`${name}.csv.meta.json`, JSON.stringify(ledger.meta, null, 2) + "\n", "application/json");
      setLast(ledger);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ledger-title" className="md-glass mb-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="ledger-title" className="font-semibold">On-chain ledger export</h2>
          <p className="mt-1 text-sm text-stone-600">
            Every payment and refund for your store, read straight from the chain. Keep the metadata file: together with the
            CSV it lets you re-check the export against the chain (the ledger service's verify call, about a minute).
          </p>
        </div>
        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">{useFixtures ? "Synthetic sample" : live ? "Live from chain" : "Not connected"}</span>
      </div>

      {useFixtures ? (
        <>
          <dl className="my-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div><dt className="text-xs text-stone-600">Block range</dt><dd className="font-medium tabular-nums">{metadata.fromBlock}–{metadata.toBlock}</dd></div>
            <div><dt className="text-xs text-stone-600">Confirmations</dt><dd className="font-medium tabular-nums">{metadata.confirmations}</dd></div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <a href={csvUrl} download="synthetic-sample.csv" className="rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700">Download CSV</a>
            <a href={metadataUrl} download="synthetic-sample.csv.meta.json" className="rounded border border-stone-300 px-3 py-2 text-sm font-medium text-stone-800 hover:bg-stone-50">Download metadata JSON</a>
          </div>
        </>
      ) : live ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" data-testid="ledger-download" onClick={() => void download()} disabled={busy || !token} className="rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50">
            {busy ? "Preparing ledger…" : "Download ledger CSV + metadata"}
          </button>
          {!token && <span className="text-sm text-stone-600">Sign in to download.</span>}
          {last && (
            <span role="status" className="text-sm text-stone-700">
              Downloaded {ledgerRowCount(last.csv)} ledger rows, blocks {last.meta.fromBlock}–{last.meta.toBlock} ({last.meta.confirmations} confirmations).
            </span>
          )}
          {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
        </div>
      ) : (
        <p className="mt-4 text-sm text-stone-600">Connect the merchant server to download the live ledger.</p>
      )}
    </section>
  );
}
