/** Typed client for the store's /links routes, plus form validation and share-URL helpers. */
export type LinkStatus = "active" | "paid" | "deactivated" | "expired";

export interface LinkView {
  id: string;
  title: string;
  description: string | null;
  amount: string;
  amountBase: string;
  singleUse: boolean;
  status: LinkStatus;
  paidCount: number;
  expiresAt: string | null;
  createdAt: string;
  lastPaidOrderId: string | null;
  duplicatePayments: number;
}

export interface NewLink {
  title: string;
  amount: string;
  description?: string;
  singleUse?: boolean;
  expiresInDays?: number;
}

export class PaymentLinksError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface Opts {
  merchantUrl: string;
  token: string;
  fetch?: typeof fetch;
}

async function call<T>(opts: Opts, path: string, method: "GET" | "POST", payload?: unknown): Promise<T> {
  if (!opts.token) throw new PaymentLinksError("Sign in to manage payment links.", 401);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${opts.merchantUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch {
    throw new PaymentLinksError("The merchant server is not reachable.");
  }
  const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!res.ok) {
    if (res.status === 401) throw new PaymentLinksError("Your session expired. Sign in again.", 401);
    const e = body?.error;
    const msg = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : "";
    throw new PaymentLinksError(msg || `Request failed (${res.status}).`, res.status);
  }
  return body as T;
}

const isLink = (v: unknown): v is LinkView => !!v && typeof v === "object" && typeof (v as LinkView).id === "string" && typeof (v as LinkView).status === "string";

async function one(p: Promise<unknown>): Promise<LinkView> {
  const b = await p;
  if (!isLink(b)) throw new PaymentLinksError("The payment link response was malformed.");
  return b;
}

export async function listLinks(opts: Opts): Promise<LinkView[]> {
  const b = await call<{ links?: unknown }>(opts, "/links", "GET");
  if (!Array.isArray(b?.links) || !b.links.every(isLink)) throw new PaymentLinksError("The payment links response was malformed.");
  return b.links;
}

export const createLink = (opts: Opts, link: NewLink) => one(call(opts, "/links", "POST", link));

export const deactivateLink = (opts: Opts, id: string) => one(call(opts, `/links/${encodeURIComponent(id)}/deactivate`, "POST", {}));

// ---- validation: each returns an error message, or "" when valid ----
export const validateTitle = (t: string): string => {
  const v = t.trim();
  return v.length >= 1 && v.length <= 80 ? "" : "Title must be 1 to 80 characters.";
};

export const validateAmount = (a: string): string => {
  const v = a.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(v)) return "Enter an amount like 12.50 (up to 6 decimals).";
  const n = Number(v);
  if (!(n > 0)) return "Amount must be greater than 0.";
  if (n > 1_000_000) return "Amount can be at most 1,000,000 USDT.";
  return "";
};

export const validateDescription = (d: string): string => (d.trim().length <= 280 ? "" : "Description can be at most 280 characters.");

/** Empty means no expiry. */
export const validateExpiryDays = (d: string): string => {
  const v = d.trim();
  if (v === "") return "";
  if (!/^\d+$/.test(v)) return "Expiry must be a whole number of days from 1 to 90.";
  const n = Number(v);
  return n >= 1 && n <= 90 ? "" : "Expiry must be a whole number of days from 1 to 90.";
};

// ---- share helpers ----
export const shareMessage = (title: string, amount: string, url: string) => `Pay ${amount} USDT for ${title}: ${url}`;

export const whatsappUrl = (title: string, amount: string, url: string) => `https://wa.me/?text=${encodeURIComponent(shareMessage(title, amount, url))}`;

export const mailtoUrl = (title: string, amount: string, url: string) =>
  `mailto:?subject=${encodeURIComponent(`Payment request: ${title}`)}&body=${encodeURIComponent(`Hello,\n\nPlease pay ${amount} USDT for ${title} using this secure link:\n${url}\n\nNo crypto fees to pay: the payment is gasless.`)}`;

export const statusText: Record<LinkStatus, string> = { active: "Active", paid: "Paid", deactivated: "Deactivated", expired: "Expired" };
