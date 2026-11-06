import { createElement, useEffect, useRef } from "react";
import type { Order } from "@quietpay/shared";
import "./element.js";

export interface QuietpayCheckoutProps {
  orderId: string;
  relayerUrl: string;
  onSettled?: (order: Order) => void;
  onError?: (err: { code: string; message: string }) => void;
}

/** React wrapper around the <quietpay-checkout> custom element. */
export function QuietpayCheckout({ orderId, relayerUrl, onSettled, onError }: QuietpayCheckoutProps) {
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

  return createElement("quietpay-checkout", { ref, "order-id": orderId, "relayer-url": relayerUrl });
}
