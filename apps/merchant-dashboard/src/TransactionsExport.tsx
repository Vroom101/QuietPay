import { useState } from "react";
import { buildTransactionsCsv, downloadText } from "./lib/csv";
import type { DashboardOrder } from "./lib/view";

/** Downloads the transactions currently shown, optionally with the network gas the relayer paid per order. */
export function TransactionsExport({ orders, label = "transactions" }: { orders: DashboardOrder[]; label?: string }) {
  const [includeGas, setIncludeGas] = useState(true);
  const gasAvailable = orders.some((o) => o.gasWei !== undefined);
  return (
    <div className="md-export flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" data-testid="include-gas" checked={includeGas && gasAvailable} disabled={!gasAvailable} onChange={(e) => setIncludeGas(e.target.checked)} />
        Include gas fees (WBT)
      </label>
      <button
        type="button"
        data-testid="transactions-csv"
        disabled={!orders.length}
        onClick={() => downloadText(`quietpay-${label}-${new Date().toISOString().slice(0, 10)}.csv`, buildTransactionsCsv(orders, { includeGas: includeGas && gasAvailable }))}
      >
        Download CSV ({orders.length})
      </button>
    </div>
  );
}
