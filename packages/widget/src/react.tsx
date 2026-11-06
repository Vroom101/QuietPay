import { createElement, useEffect, useRef } from "react";
import type { Order } from "@quietpay/shared";
import "./element.js";

export interface QuietpayCheckoutProps {
  orderId: string;
  relayerUrl: string;
  /** Decimal USDT amount the shop expects (e.g. "25.5"); the widget refuses to sign anything else. */
  expectedAmount?: string;
  /** Overrides for local test chains only. Defaults: chain 1874, official USDT, deployed router. */
  chainId?: number;
  token?: string;
  router?: string;
  domainName?: string;
  domainVersion?: string;
  expectedPayout?: string;
  onSettled?: (order: Order) => void;
  onError?: (err: { code: string; message: string }) => void;
}

/** React wrapper around the <quietpay-checkout> custom element. */
export function QuietpayCheckout({
  orderId,
  relayerUrl,
  expectedAmount,
  chainId,
  token,
  router,
  domainName,
  domainVersion,
  expectedPayout,
  onSettled,
  onError,
}: QuietpayCheckoutProps) {
  const ref = useRef<HTMLElement>(null);
  const cbs = useRef({ onSettled, onError });
  cbs.current = { onSettled, onError };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const settled = (e: Event) => cbs.current.onSettled?.((e as CustomEvent).detail.order);
    const error = (e: Event) => cbs.current.onError?.((e as CustomEvent).detail);
    el.addEventListener("quietpay:settled", settled);
    el.addEventListener("quietpay:error", error);
    return () => {
      el.removeEventListener("quietpay:settled", settled);
      el.removeEventListener("quietpay:error", error);
    };
  }, []);

  const attrs: Record<string, unknown> = { ref, "order-id": orderId, "relayer-url": relayerUrl };
  if (expectedAmount !== undefined) attrs["expected-amount"] = expectedAmount;
  if (chainId !== undefined) attrs["chain-id"] = String(chainId);
  if (token !== undefined) attrs["token"] = token;
  if (router !== undefined) attrs["router"] = router;
  if (domainName !== undefined) attrs["domain-name"] = domainName;
  if (domainVersion !== undefined) attrs["domain-version"] = domainVersion;
  if (expectedPayout !== undefined) attrs["expected-payout"] = expectedPayout;
  return createElement("quietpay-checkout", attrs);
}
