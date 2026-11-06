import type { LogSource } from "@quietpay/indexer";

/** What the verifier needs from a node: the indexer's LogSource plus eth_chainId. Faked in tests. */
export interface VerifierSource extends LogSource {
  getChainId(): Promise<number>;
}

export type CheckName = "structure" | "sidecar" | "finality" | "rows" | "event_set_hash" | "invariants" | "timestamps";
export type CheckStatus = "pass" | "fail" | "skipped";

export type IssueCode =
  // structure
  | "crlf_line_endings"
  | "missing_trailing_newline"
  | "bad_header"
  | "empty_line"
  | "bad_cell_count"
  | "bad_date"
  | "bad_source"
  | "bad_status"
  | "bad_hex"
  | "bad_amount"
  | "bad_integer"
  | "not_sorted"
  | "duplicate_row"
  | "row_out_of_range"
  // sidecar / finality
  | "bad_sidecar"
  | "to_block_not_final"
  // rows (CSV vs rows rebuilt from chain logs)
  | "missing_row"
  | "extra_row"
  | "wrong_field"
  | "wrong_amount"
  | "wrong_refunded"
  | "wrong_status"
  | "wrong_tx_hash"
  | "wrong_block"
  | "wrong_log_index"
  // event set
  | "event_set_hash_mismatch"
  // invariants straight from chain events and USDT transfers
  | "invariant_gross"
  | "invariant_fee"
  | "invariant_refunded"
  | "invariant_net"
  | "invariant_status"
  | "transfer_mismatch"
  // timestamps
  | "wrong_date";

export interface Issue {
  check: CheckName;
  code: IssueCode;
  message: string;
  /** 1-based line in the CSV file (the header is line 1). */
  line?: number;
  /** `tx_hash:log_index` of the row concerned. */
  key?: string;
  field?: string;
  expected?: string;
  actual?: string;
}

export interface VerifyReport {
  ok: boolean;
  verifier: string;
  chainId: number;
  router: string;
  usdt: string;
  payTo: string | null;
  fromBlock: number | null;
  toBlock: number | null;
  confirmations: number | null;
  headBlock: number | null;
  finalizedBlock: number | null;
  rowsInCsv: number;
  rowsExpected: number | null;
  eventsInRange: number | null;
  eventSetHash: { sidecar: string | null; recomputed: string | null };
  checks: Record<CheckName, CheckStatus>;
  issues: Issue[];
  trust: string;
}
