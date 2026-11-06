import { buildLedger } from "./ledger.js";
import { writeCsv } from "./csv.js";
import {
  ExportMetaSchema,
  eventSetHash,
  normalizeScope,
  selectedEvents,
  type RecordedEvent,
  type Scope,
  type ExportBundle,
} from "./model.js";

export function createExport(
  history: RecordedEvent[],
  scope: Scope,
  options: {
    fromBlock: number;
    toBlock: number;
    toBlockHash: string;
    merchantId?: string;
    generatedAt?: string;
  },
): ExportBundle {
  const rows = buildLedger(history).entries.filter(
    (row) =>
      Number(row.block) >= options.fromBlock &&
      Number(row.block) <= options.toBlock &&
      (!options.merchantId ||
        row.merchant_id === options.merchantId.toLowerCase()),
  );
  return {
    csv: writeCsv(rows),
    meta: ExportMetaSchema.parse({
      ...normalizeScope(scope),
      schemaVersion: 1,
      layout: "event-journal-v1",
      fromBlock: options.fromBlock,
      toBlock: options.toBlock,
      toBlockHash: options.toBlockHash.toLowerCase(),
      eventSetHash: eventSetHash(
        selectedEvents(
          history,
          options.fromBlock,
          options.toBlock,
          options.merchantId,
        ),
      ),
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      ...(options.merchantId
        ? { merchantId: options.merchantId.toLowerCase() }
        : {}),
    }),
  };
}
