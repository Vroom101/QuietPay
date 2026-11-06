/** A log as returned by eth_getLogs, with numbers already converted. Addresses and hashes are lowercase hex. */
export interface ChainLog {
  address: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  topics: string[];
  data: string;
}

export type RawKind =
  | "Paid"
  | "Refunded"
  | "MerchantRegistered"
  | "PayoutChanged"
  | "RelayerSet"
  | "Transfer";

/** A decoded event as stored. All numeric args are decimal strings (they are uint256 base units). */
export interface RawEvent {
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  /** Block timestamp, unix seconds. */
  timestamp: number;
  address: string;
  kind: RawKind;
  args: Record<string, string>;
}

export type LedgerSource = "router" | "payto_transfer";
export type LedgerStatus = "settled" | "partially_refunded" | "refunded";

/** One ledger row. Amounts are strings with exactly 6 places. */
export interface LedgerRow {
  /** Stable identity: `merchantId:orderId` for router rows, `txHash:logIndex` for payto_transfer rows. */
  key: string;
  dateUtc: string;
  source: LedgerSource;
  orderId: string;
  merchantId: string;
  payer: string;
  grossUsdt: string;
  relayFeeUsdt: string;
  refundedUsdt: string;
  netUsdt: string;
  status: LedgerStatus;
  txHash: string;
  block: number;
  logIndex: number;
}

export interface ExportMeta {
  fromBlock: number;
  toBlock: number;
  confirmations: number;
  eventSetHash: string;
  /** What the export covered, so a verifier can refuse a mismatched setup. Absent in exports made before 2026-11-06. */
  router?: string;
  usdt?: string;
  payTo?: string | null;
  generatedAt: string;
}
