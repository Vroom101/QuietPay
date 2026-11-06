import { scan } from "./chain.js";
import { readCsv } from "./csv.js";
import { createExport } from "./export.js";
import { CSV_COLUMNS, type LedgerRow } from "./ledger.js";
import {
  ExportMetaSchema,
  normalizeScope,
  type Scope,
  type ChainReader,
  type ExportBundle,
} from "./model.js";

const key = (row: LedgerRow) => `${row.tx_hash.toLowerCase()}:${row.log_index}`;
/** Independent verifier: no database or indexer state is consulted. Scope comes from the auditor. */
export async function verifyExport(
  chain: ChainReader,
  trustedScope: Scope,
  bundle: ExportBundle,
  expected: { merchantId?: string; fromBlock?: number; toBlock?: number } = {},
) {
  const meta = ExportMetaSchema.parse(bundle.meta),
    scope = normalizeScope(trustedScope);
  const declared = normalizeScope(meta);
  if (
    declared.chainId !== scope.chainId ||
    declared.router !== scope.router ||
    declared.token !== scope.token ||
    declared.deploymentBlock !== scope.deploymentBlock ||
    JSON.stringify(declared.agent) !== JSON.stringify(scope.agent) ||
    meta.confirmations < scope.confirmations
  )
    throw new Error(
      "Export does not match the independently configured chain, contracts or confirmation policy",
    );
  if (
    expected.merchantId &&
    meta.merchantId?.toLowerCase() !== expected.merchantId.toLowerCase()
  )
    throw new Error("Export merchant does not match the requested merchant");
  if (
    (expected.fromBlock !== undefined &&
      meta.fromBlock !== expected.fromBlock) ||
    (expected.toBlock !== undefined && meta.toBlock !== expected.toBlock)
  )
    throw new Error("Export range does not match the auditor's expected range");
  if ((await chain.getChainId()) !== scope.chainId)
    throw new Error("Verifier RPC is on the wrong chain");
  if (meta.toBlock > (await chain.getHead()) - meta.confirmations)
    throw new Error("Export includes unconfirmed blocks");
  const anchorBefore = await chain.getBlock(meta.toBlock);
  // Pre-range payment history is needed to validate refund-only export ranges.
  const history = await scan(chain, scope.deploymentBlock, meta.toBlock);
  const anchorAfter = await chain.getBlock(meta.toBlock);
  if (anchorBefore.hash !== anchorAfter.hash)
    throw new Error("Chain changed during verification; retry");
  const rebuilt = createExport(history, scope, {
    fromBlock: meta.fromBlock,
    toBlock: meta.toBlock,
    toBlockHash: anchorAfter.hash,
    merchantId: meta.merchantId,
    generatedAt: meta.generatedAt,
  });
  const actual = readCsv(bundle.csv),
    wanted = readCsv(rebuilt.csv);
  const expectedRows = new Map(wanted.map((r) => [key(r), r]));
  const groups = new Map<string, { row: LedgerRow; line: number }[]>();
  actual.forEach((row, i) => {
    const k = key(row),
      group = groups.get(k) ?? [];
    group.push({ row, line: i + 2 });
    groups.set(k, group);
  });
  const matched: string[] = [],
    missing: LedgerRow[] = [],
    extra: { row: LedgerRow; line: number }[] = [],
    altered: {
      key: string;
      line: number;
      fields: { field: string; expected: string; actual: string }[];
    }[] = [],
    duplicates: { key: string; lines: number[] }[] = [];
  for (const [k, rows] of groups) {
    if (rows.length > 1)
      duplicates.push({ key: k, lines: rows.map((r) => r.line) });
    const want = expectedRows.get(k);
    if (!want) {
      extra.push(...rows);
      continue;
    }
    // Inspect every duplicate too: a clean first copy must not hide a modified second copy.
    for (const { row, line } of rows) {
      const fields = CSV_COLUMNS.filter((c) => row[c] !== want[c]).map(
        (field) => ({ field, expected: want[field], actual: row[field] }),
      );
      if (fields.length) altered.push({ key: k, line, fields });
    }
    if (!altered.some((a) => a.key === k)) matched.push(k);
  }
  for (const [k, row] of expectedRows) if (!groups.has(k)) missing.push(row);
  const eventSetHashMatches =
      meta.eventSetHash.toLowerCase() === rebuilt.meta.eventSetHash,
    toBlockHashMatches =
      meta.toBlockHash.toLowerCase() === anchorAfter.hash.toLowerCase();
  return {
    ok:
      !altered.length &&
      !missing.length &&
      !extra.length &&
      !duplicates.length &&
      eventSetHashMatches &&
      toBlockHashMatches,
    counts: {
      matched: matched.length,
      altered: altered.length,
      missing: missing.length,
      extra: extra.length,
      duplicates: duplicates.length,
    },
    altered,
    missing,
    extra,
    duplicates,
    eventSetHashMatches,
    toBlockHashMatches,
    checkpoint: {
      chainId: scope.chainId,
      router: scope.router,
      token: scope.token,
      fromBlock: meta.fromBlock,
      toBlock: meta.toBlock,
      confirmations: meta.confirmations,
      merchantId: meta.merchantId ?? null,
      eventCount: history.filter(
        ({ event: e }) =>
          e.blockNumber >= meta.fromBlock &&
          (!meta.merchantId ||
            e.merchantId.toLowerCase() === meta.merchantId.toLowerCase()),
      ).length,
      eventSetHash: rebuilt.meta.eventSetHash,
      toBlockHash: anchorAfter.hash,
    },
  };
}
