export interface PaymentMethod {
  id: string;
  name: string;
  symbol: string;
  simulated: boolean;
}

export interface DemoQuote {
  id: string;
  symbol: string;
  settlementSymbol: string;
  payAmount: string;
  merchantAmount: string;
  relayFee: string;
  expiresAt: number;
}

export const directPayment: PaymentMethod = { id: "usdt", name: "Tether USD", symbol: "USDT", simulated: false };

export type PaymentStatus =
  | { paid: false; simulation?: { quote: DemoQuote; confirmedAt: number } }
  | { paid: true; amount: string; paidAt: number; txHash?: string; demo?: boolean };

export async function readPayment(id: string, signal: AbortSignal): Promise<PaymentStatus> {
  const response = await fetch(`/api/orders/${encodeURIComponent(id)}/paid`, { signal });
  if (!response.ok) throw new Error("Could not load payment status");
  return response.json() as Promise<PaymentStatus>;
}
