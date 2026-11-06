import { decodeEventLog, parseAbi, type Hex } from "viem";
import { paymentRouterAbi } from "@quietpay/shared";
import type { ChainLog, RawKind } from "./types.js";

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ROUTER_KINDS = new Set<string>(["Paid", "Refunded", "MerchantRegistered", "PayoutChanged", "RelayerSet", "RefundSignerChanged"]);

export interface Decoded {
  kind: RawKind;
  args: Record<string, string>;
}

function stringify(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? v.toLowerCase() : String(v);
  }
  return out;
}

/** Decodes a PaymentRouter log. Returns null for events the ledger does not use (ownership, pause, ...). */
export function decodeRouterLog(log: Pick<ChainLog, "topics" | "data">): Decoded | null {
  try {
    const d = decodeEventLog({
      abi: paymentRouterAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data as Hex,
    });
    if (!ROUTER_KINDS.has(d.eventName as string)) return null;
    return { kind: d.eventName as RawKind, args: stringify((d.args ?? {}) as Record<string, unknown>) };
  } catch {
    return null;
  }
}

/** Decodes an ERC-20 Transfer log. Returns null for anything else (including ERC-721 Transfers). */
export function decodeTransferLog(log: Pick<ChainLog, "topics" | "data">): Decoded | null {
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) return null;
  try {
    const d = decodeEventLog({
      abi: transferAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data as Hex,
    });
    return { kind: "Transfer", args: stringify(d.args as unknown as Record<string, unknown>) };
  } catch {
    return null;
  }
}
