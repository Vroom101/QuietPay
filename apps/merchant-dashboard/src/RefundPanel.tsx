import { useCallback, useEffect, useRef, useState } from "react";
import type { MerchantRefundView, Order } from "@quietpay/shared";
import {
  DashboardError,
  getMerchantRefundView,
  submitMerchantRefund,
  type MerchantOptions,
} from "./lib/api";
import { decimalAmount, preciseUsdt, refundProblem } from "./lib/refunds";
import { shortHex } from "./lib/view";

type Attempt = { requestId: string; amount: string; refundIndex: number };
export function RefundPanel({
  order,
  options,
  onChanged,
  onClose,
}: {
  order: Order;
  options: MerchantOptions;
  onChanged: () => void;
  onClose: () => void;
}) {
  const storageKey = `qp-refund:${options.merchantUrl}:${order.id}`;
  const [attempt, setAttempt] = useState<Attempt | undefined>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      return saved &&
        typeof saved.requestId === "string" &&
        /^[1-9][0-9]*$/.test(saved.amount) &&
        Number.isSafeInteger(saved.refundIndex)
        ? saved
        : undefined;
    } catch {
      return undefined;
    }
  });
  const [state, setState] = useState<MerchantRefundView>();
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const loading = useRef(false),
    terminal = useRef(new Set<string>()),
    changed = useRef(onChanged);
  changed.current = onChanged;
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const next = await getMerchantRefundView(options, order.id);
      setState(next);
      setError(undefined);
      const latest = next.requests[0];
      if (latest && ["settled", "failed"].includes(latest.status))
        setNotice(
          latest.status === "settled"
            ? "Refund completed."
            : "Refund failed. Review its status below.",
        );
      for (const request of next.requests) {
        if (
          ["settled", "failed"].includes(request.status) &&
          !terminal.current.has(request.requestId)
        ) {
          terminal.current.add(request.requestId);
          changed.current();
        }
      }
      setAttempt((current) => {
        if (
          current &&
          next.requests.some(
            (r) =>
              r.requestId === current.requestId &&
              ["settled", "failed"].includes(r.status),
          )
        ) {
          try {
            localStorage.removeItem(storageKey);
          } catch {
            /* server journal remains authoritative */
          }
          return undefined;
        }
        return current;
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load refund status.",
      );
    } finally {
      loading.current = false;
    }
  }, [options.merchantUrl, options.apiKey, order.id, storageKey]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);
  const problem = state
    ? refundProblem(state, amount)
    : "Loading refund balance…";
  const remaining = state
    ? BigInt(state.context.amountPaid) - BigInt(state.context.refunded)
    : 0n;
  const locked = busy || !!attempt || !!error;
  async function send(saved?: Attempt) {
    if (!state || busy) return;
    const next = saved ?? {
      requestId: crypto.randomUUID(),
      amount: decimalAmount(amount)!.toString(),
      refundIndex: state.context.refundIndex,
    };
    // Persist the business request before sending. Reloads reuse its identity and expected index.
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      setError(
        "Browser storage is unavailable. Enable storage before starting a refund.",
      );
      return;
    }
    setAttempt(next);
    setBusy(true);
    setReview(false);
    setError(undefined);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const result = await submitMerchantRefund(options, order.id, next);
      setNotice(
        result.status === "settled"
          ? "Refund completed."
          : result.status === "failed"
            ? "Refund failed. Review its status below."
            : "Refund request recorded. Checking settlement…",
      );
      if (["settled", "failed"].includes(result.status)) {
        localStorage.removeItem(storageKey);
        setAttempt(undefined);
        changed.current();
      }
    } catch (e) {
      setActionError(
        e instanceof Error
          ? e.message
          : "Could not confirm the refund request.",
      );
      // These are explicit rejections from the merchant server, not an uncertain transport response.
      if (
        e instanceof DashboardError &&
        e.status &&
        [400, 401, 403, 404, 409, 422, 429, 503].includes(e.status) &&
        e.code &&
        !["refund_service_unavailable", "refunds_not_configured"].includes(
          e.code,
        )
      ) {
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* an old request ID remains safe to recheck */
        }
        setAttempt(undefined);
      }
    } finally {
      setBusy(false);
      await load();
    }
  }
  return (
    <section
      aria-label="Order refunds"
      className="mb-6 rounded-lg border border-stone-300 bg-white p-5 shadow-sm"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Refund payment</h2>
          <p className="text-xs text-stone-500">
            {order.reference ?? shortHex(order.id)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded border px-3 py-1 text-sm"
        >
          Close
        </button>
      </div>
      {state && (
        <>
          <dl className="mb-5 grid gap-3 border-l-4 border-emerald-600 bg-stone-50 p-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-stone-500">Original payment</dt>
              <dd className="font-mono text-sm">
                {preciseUsdt(state.context.amountPaid)} USDT
              </dd>
            </div>
            <div>
              <dt className="text-xs text-stone-500">Already refunded</dt>
              <dd className="font-mono text-sm">
                {preciseUsdt(state.context.refunded)} USDT
              </dd>
            </div>
            <div>
              <dt className="text-xs text-stone-500">Available to refund</dt>
              <dd className="font-mono text-sm font-semibold">
                {preciseUsdt(remaining)} USDT
              </dd>
            </div>
          </dl>
          <p className="text-sm">
            Refund wallet balance:{" "}
            <strong className="font-mono">
              {preciseUsdt(state.context.refundBalance)} USDT
            </strong>
          </p>
          <p className="mt-1 break-all text-xs text-stone-500">
            Refund wallet: {state.context.refundSigner}
          </p>
          <p className="mt-1 break-all text-xs text-stone-500">
            Funds return to the original payer: {state.context.payer}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!problem && !locked) setReview(true);
            }}
            className="mt-5 flex flex-wrap items-end gap-3"
          >
            <label className="text-sm">
              Refund amount (USDT)
              <input
                aria-label="Refund amount (USDT)"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setReview(false);
                }}
                inputMode="decimal"
                disabled={locked || remaining === 0n}
                className="mt-1 block w-52 rounded border border-stone-300 px-3 py-2 font-mono disabled:bg-stone-100"
                placeholder="0.000000"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setAmount(preciseUsdt(remaining));
                setReview(false);
              }}
              disabled={locked || remaining === 0n}
              className="rounded border px-3 py-2 text-sm disabled:opacity-40"
            >
              Use remaining amount
            </button>
            <button
              disabled={!!problem || locked}
              className="rounded bg-stone-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Review refund
            </button>
          </form>
          {problem && (
            <p className="mt-2 text-sm text-amber-800" role="status">
              {problem}
            </p>
          )}
          {review && !problem && !locked && (
            <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm">
                Return{" "}
                <strong>{preciseUsdt(decimalAmount(amount)!)} USDT</strong> to
                the original payer? The merchant refund wallet supplies this
                amount.
              </p>
              <button
                type="button"
                onClick={() => void send()}
                className="mt-3 rounded bg-stone-900 px-4 py-2 text-sm text-white"
              >
                Confirm refund
              </button>
              <button
                type="button"
                onClick={() => setReview(false)}
                className="ml-3 text-sm underline"
              >
                Cancel
              </button>
            </div>
          )}
          {attempt && (
            <div className="mt-4 rounded bg-amber-50 p-3 text-sm">
              <p>
                Request for {preciseUsdt(attempt.amount)} USDT is awaiting
                confirmation. Reuse this request to check it; do not create
                another.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void send(attempt)}
                className="mt-2 underline disabled:opacity-40"
              >
                Check original request
              </button>
            </div>
          )}
          <div className="mt-6 border-t pt-4">
            <h3 className="font-medium">Refund history</h3>
            {!state.refunds.length && (
              <p className="mt-2 text-sm text-stone-500">
                No refunds recorded.
              </p>
            )}
            <ul className="mt-2 space-y-2">
              {state.refunds.map((refund) => (
                <li
                  key={refund.id}
                  className="rounded border border-stone-200 p-3 text-sm"
                >
                  <span className="font-mono">
                    {preciseUsdt(refund.amount)} USDT
                  </span>{" "}
                  <strong className="ml-2">{refund.status}</strong>
                  {refund.failureCode && (
                    <p className="mt-1 text-red-800">
                      Refund failed ({refund.failureCode}). Review the cause
                      before creating a new request.
                    </p>
                  )}
                  {refund.txHash && (
                    <p className="mt-1 break-all font-mono text-xs text-stone-500">
                      Transaction {refund.txHash}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {state.requests
              .filter(
                (r) =>
                  ["unknown", "submitting", "failed"].includes(r.status) &&
                  !r.refund,
              )
              .map((request) => (
                <p
                  key={request.requestId}
                  className="mt-2 rounded bg-amber-50 p-3 text-sm"
                >
                  {preciseUsdt(request.amount)} USDT —{" "}
                  {request.status === "failed"
                    ? `Request rejected (${request.failureCode ?? "unknown reason"}).`
                    : "Status uncertain. Wait and refresh; the operator must reconcile this request before another refund."}
                </p>
              ))}
          </div>
        </>
      )}
      {!state && !error && <p role="status">Loading refund balance…</p>}
      {busy && (
        <p role="status" className="mt-3 text-sm">
          Sending the refund request…
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {actionError}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void load()}
        className="mt-4 text-sm underline"
      >
        Refresh refund status
      </button>
    </section>
  );
}
