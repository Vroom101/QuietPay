import csvUrl from "./fixtures/synthetic-sample.csv?url";
import metadataUrl from "./fixtures/synthetic-sample.csv.meta.json?url";
import metadata from "./fixtures/synthetic-sample.csv.meta.json";

export function LedgerExport({ useFixtures }: { useFixtures: boolean }) {
  return (
    <section aria-labelledby="ledger-title" className="mb-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="ledger-title" className="font-semibold">Ledger export</h2>
          <p className="mt-1 text-sm text-stone-600">Download the transaction CSV and keep its matching metadata for verification.</p>
        </div>
        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-700">
          {useFixtures ? "Synthetic sample" : "Live export unavailable"}
        </span>
      </div>

      {useFixtures ? (
        <>
          <dl className="my-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-stone-600">Block range</dt>
              <dd className="font-medium tabular-nums">{metadata.fromBlock}–{metadata.toBlock}</dd>
            </div>
            <div>
              <dt className="text-xs text-stone-600">Confirmations</dt>
              <dd className="font-medium tabular-nums">{metadata.confirmations}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <a href={csvUrl} download="synthetic-sample.csv" className="rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700">Download CSV</a>
            <a href={metadataUrl} download="synthetic-sample.csv.meta.json" className="rounded border border-stone-300 px-3 py-2 text-sm font-medium text-stone-800 hover:bg-stone-50">Download metadata JSON</a>
          </div>
        </>
      ) : (
        <p className="mt-4 text-sm text-stone-600">Live downloads will appear here when the ledger export endpoint is connected.</p>
      )}
    </section>
  );
}
