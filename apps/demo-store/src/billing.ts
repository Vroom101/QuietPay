export interface DemoRefund {
  id: string;
  amount: string;
  createdAt: number;
}

export interface DemoOrder {
  id: string;
  amount: string;
  placedAt: number;
  refunds: DemoRefund[];
}

export interface DemoInvoice {
  id: string;
  kind: "invoice" | "link";
  client: string;
  description: string;
  amount: string;
  dueDate: string | null;
  reminderDays: number | null;
  paymentId?: string;
}

export interface DemoPlan {
  id: string;
  name: string;
  amount: string;
  interval: "month" | "year";
}

export interface DemoSubscription {
  id: string;
  plan: DemoPlan;
  status: "active" | "cancelled";
  nextCharge: string | null;
}

export async function billingRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const result = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(result?.error ?? "The demo service is unavailable.");
  return result as T;
}

export function billingPost<T>(path: string, body: object = {}) {
  return billingRequest<T>(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

export function invoiceStatus(invoice: DemoInvoice) {
  if (invoice.paymentId) return "Paid";
  return invoice.dueDate && invoice.dueDate < new Date().toISOString().slice(0, 10) ? "Overdue" : "Unpaid";
}
