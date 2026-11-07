import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createLink, deactivateLink, listLinks, mailtoUrl, statusText, validateAmount, validateDescription, validateExpiryDays, validateTitle, whatsappUrl, type LinkView, type NewLink,
} from "./lib/payment-links";

const STORE_URL = import.meta.env.VITE_STORE_URL || "http://localhost:5173";
const base = () => STORE_URL.replace(/\/+$/, "");
export const payLink = (id: string) => `${base()}/pay/${encodeURIComponent(id)}`;
export const receiptLink = (orderId: string) => `${base()}/success/${encodeURIComponent(orderId)}`;

const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : "—");
const badgeColor: Record<LinkView["status"], string> = {
  active: "bg-green-100 text-green-800",
  paid: "bg-blue-100 text-blue-800",
  deactivated: "bg-stone-200 text-stone-700",
  expired: "bg-amber-100 text-amber-800",
};
const btn = "rounded border border-stone-300 px-3 py-1 text-sm";

function CopyButton({ url }: { url: string }) {
  const [msg, setMsg] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMsg("Link copied.");
    } catch {
      setMsg("Copy the link from the box.");
    }
  }
  return (
    <>
      <button type="button" onClick={() => void copy()} className={btn}>Copy link</button>
      {msg && <span role="status" className="text-sm text-stone-600">{msg}</span>}
    </>
  );
}

function NewLinkCard({ link }: { link: LinkView }) {
  const url = payLink(link.id);
  const ext = { target: "_blank", rel: "noopener noreferrer", className: btn } as const;
  return (
    <div data-testid="new-link" className="mt-4 rounded-lg border border-green-300 bg-green-50 p-4">
      <p className="text-sm font-semibold">Your payment link is ready: {link.title} · {link.amount} USDT</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input readOnly aria-label="Payment link" value={url} className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-xs" onFocus={(e) => e.currentTarget.select()} />
        <CopyButton url={url} />
        <a href={whatsappUrl(link.title, link.amount, url)} {...ext}>Share on WhatsApp</a>
        <a href={mailtoUrl(link.title, link.amount, url)} {...ext}>Email</a>
        <a href={url} {...ext}>Open</a>
      </div>
    </div>
  );
}

export function PaymentLinksPanel({ merchantUrl, token }: { merchantUrl: string; token?: string }) {
  const [links, setLinks] = useState<LinkView[]>([]);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [reusable, setReusable] = useState(false);
  const [expiry, setExpiry] = useState("");
  const [created, setCreated] = useState<LinkView | null>(null);
  const [confirming, setConfirming] = useState("");
  const [busyId, setBusyId] = useState("");
  const [rowError, setRowError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      setLinks(await listLinks({ merchantUrl, token }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [merchantUrl, token]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError("");
    const bad = validateTitle(title) || validateAmount(amount) || validateDescription(description) || validateExpiryDays(expiry);
    if (bad) return setFormError(bad);
    const body: NewLink = { title: title.trim(), amount: amount.trim(), singleUse: !reusable };
    if (description.trim()) body.description = description.trim();
    if (expiry.trim()) body.expiresInDays = Number(expiry.trim());
    setSaving(true);
    try {
      const link = await createLink({ merchantUrl, token: token ?? "" }, body);
      setLinks((cur) => [link, ...cur]);
      setCreated(link);
      setTitle("");
      setAmount("");
      setDescription("");
      setExpiry("");
      setReusable(false);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(id: string) {
    setRowError("");
    setBusyId(id);
    try {
      const updated = await deactivateLink({ merchantUrl, token: token ?? "" }, id);
      setLinks((cur) => cur.map((l) => (l.id === id ? updated : l)));
      setCreated((c) => (c && c.id === id ? updated : c));
      setConfirming("");
    } catch (err) {
      setRowError((err as Error).message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <section aria-labelledby="links-title" className="md-glass mb-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-5">
      <h2 id="links-title" className="font-semibold">Payment links</h2>
      <p className="mt-1 text-sm text-stone-600">No website needed: send a link, your customer pays in USDT with no gas, and the money goes to your payout wallet.</p>
      {!token && <p className="mt-3 text-sm text-stone-600">Sign in to create payment links.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {loading && <p role="status" className="mt-3 text-sm text-stone-600">Loading payment links…</p>}

      <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-wrap items-end gap-3" aria-label="Create payment link">
        <label className="text-sm">What is it for?<input name="title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className="mt-1 block rounded border border-stone-300 px-2 py-1" /></label>
        <label className="text-sm">Amount (USDT)<input name="amount" value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} className="mt-1 block w-28 rounded border border-stone-300 px-2 py-1" /></label>
        <label className="text-sm">Description (optional)<input name="description" value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 block rounded border border-stone-300 px-2 py-1" /></label>
        <label className="text-sm">Expires after N days (optional)<input name="expiry" value={expiry} inputMode="numeric" onChange={(e) => setExpiry(e.target.value)} className="mt-1 block w-24 rounded border border-stone-300 px-2 py-1" /></label>
        <fieldset className="text-sm">
          <legend className="sr-only">Link type</legend>
          <label className="mr-3"><input type="radio" name="kind" value="single" checked={!reusable} onChange={() => setReusable(false)} /> One-time link</label>
          <label><input type="radio" name="kind" value="reusable" checked={reusable} onChange={() => setReusable(true)} /> Reusable link (many customers can pay)</label>
        </fieldset>
        <button type="submit" disabled={saving || !token} className="rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? "Creating…" : "Create payment link"}</button>
      </form>
      {formError && <p role="alert" className="mt-2 text-sm text-red-700">{formError}</p>}

      {created && <NewLinkCard link={created} />}

      <h3 className="mt-5 text-sm font-semibold">Your links</h3>
      {rowError && <p role="alert" className="mt-1 text-sm text-red-700">{rowError}</p>}
      {links.length === 0 ? <p className="mt-1 text-sm text-stone-600">No payment links yet.</p> : (
        <ul className="divide-y divide-stone-200">
          {links.map((l) => {
            const url = payLink(l.id);
            return (
              <li key={l.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{l.title}</strong>
                  <span>{l.amount} USDT</span>
                  <span className="text-stone-600">{l.singleUse ? "One-time" : "Reusable"}</span>
                  <span data-status={l.status} className={`rounded px-2 py-0.5 text-xs font-medium ${badgeColor[l.status]}`}>{statusText[l.status]}</span>
                  {l.duplicatePayments > 0 && (
                    <span data-testid="duplicate-warning" className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                      {l.duplicatePayments} extra payment{l.duplicatePayments === 1 ? "" : "s"} to refund
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-stone-600">Paid {l.paidCount} time{l.paidCount === 1 ? "" : "s"} · Created {fmtDate(l.createdAt)}{l.expiresAt ? ` · Expires ${fmtDate(l.expiresAt)}` : ""}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <CopyButton url={url} />
                  {l.lastPaidOrderId && <a href={receiptLink(l.lastPaidOrderId)} target="_blank" rel="noopener noreferrer" className={btn}>View receipt</a>}
                  {l.status === "active" && confirming !== l.id && <button type="button" onClick={() => { setRowError(""); setConfirming(l.id); }} className={btn}>Deactivate</button>}
                </div>
                {l.status === "active" && confirming === l.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span>Customers will no longer be able to pay this link. Deactivate it?</span>
                    <button type="button" disabled={busyId === l.id} onClick={() => void deactivate(l.id)} className="rounded bg-red-700 px-3 py-1 text-sm text-white disabled:opacity-50">Yes, deactivate</button>
                    <button type="button" onClick={() => setConfirming("")} className={btn}>Cancel</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
