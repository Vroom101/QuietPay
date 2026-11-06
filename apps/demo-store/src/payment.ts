import { tokenHeaders } from "./order-token";
import type { DemoRefund } from "./billing";
import { CustomerRefundStatus, type OrderStatus } from "@quietpay/shared";

export interface PaymentMethod {
  id: string;
  name: string;
  symbol: string;
  simulated: boolean;
}

export interface CheckoutMethods {
  methods: PaymentMethod[];
  settlementSymbol: string;
  mockRelayer: boolean;
}

export interface DemoQuote {
  id: string;
  symbol: string;
  settlementSymbol: string;
  payAmount: string;
  merchantAmount: string;
  relayFee: string;
  expiresAt: number;
  invoiceId?: string;
}

export const directPayment: PaymentMethod = { id: "usdt", name: "Tether USD", symbol: "USDT", simulated: false };

export type PaymentStatus = (
  | { paid: false; simulation?: { quote: DemoQuote; confirmedAt: number } }
  | { paid: true; amount: string; paidAt: number; txHash?: string; demo?: boolean; refunded?: string; refundCount?: number; orderStatus?: OrderStatus }
) & { refunds?: DemoRefund[] };

export async function readPayment(id: string, signal: AbortSignal): Promise<PaymentStatus> {
  // The customer status token (kept in this tab by the checkout page) proves this browser started the order.
  const response = await fetch(`/api/orders/${encodeURIComponent(id)}/paid`, { headers: tokenHeaders(id), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
  if (!response.ok) throw new Error("Could not load payment status");
  return response.json() as Promise<PaymentStatus>;
}

/**
 * The customer's own refund status (safe fields only), from the store's token-protected endpoint. The token goes in a
 * header, never in the URL. Any failure (unknown order, wrong token, network, malformed or over-sharing response)
 * returns undefined and the receipt simply shows nothing extra.
 */
export async function readRefundStatus(id: string, signal: AbortSignal): Promise<CustomerRefundStatus | undefined> {
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(id)}/refund-status`, { headers: tokenHeaders(id), signal });
    if (!response.ok) return undefined;
    const parsed = CustomerRefundStatus.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
