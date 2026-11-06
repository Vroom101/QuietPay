import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  FacilitatorRequest,
  X402Payload,
  X402Required,
  X402SettleResponse,
  DeliveryClaim,
  X402Policy,
  encodeX402Header,
  decodeX402Header,
  PAYMENT_REQUIRED,
  PAYMENT_SIGNATURE,
  PAYMENT_RESPONSE,
  type X402Policy as Policy,
} from "@quietpay/shared";
export interface PaywallOptions {
  facilitatorUrl: string;
  apiKey: string;
  policy: Policy;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
/** Express-compatible Node middleware. The resource executes only after confirmed settlement and an exclusive delivery lease. */
export function paywall(options: PaywallOptions) {
  const policy = X402Policy.parse(options.policy),
    root = options.facilitatorUrl.replace(/\/+$/, ""),
    doFetch = options.fetch ?? fetch;
  const post = async <T>(
    path: string,
    body: unknown,
    schema: { parse(v: unknown): T },
  ): Promise<T> => {
    const res = await doFetch(root + path, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
    });
    if (!res.ok) throw new Error(`Facilitator unavailable (${res.status})`);
    return schema.parse(await res.json());
  };
  return async (
    req: IncomingMessage & { originalUrl?: string },
    res: ServerResponse,
    next: (error?: unknown) => void,
  ): Promise<void> => {
    const challenge = (
      error: string,
      settlement?: z.infer<typeof X402SettleResponse>,
    ) => {
      const required = X402Required.parse({
        x402Version: 2,
        error,
        resource: policy.resource,
        accepts: [policy.requirements],
      });
      res.statusCode =
        error === "invalid_payload" || error === "invalid_resource" ? 400 : 402;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      res.setHeader(PAYMENT_REQUIRED, encodeX402Header(required));
      if (settlement)
        res.setHeader(PAYMENT_RESPONSE, encodeX402Header(settlement));
      res.end(JSON.stringify(required));
    };
    const url = new URL(policy.resource.url);
    if (
      req.method !== "GET" ||
      (req.originalUrl ?? req.url) !== url.pathname + url.search
    ) {
      challenge("invalid_resource");
      return;
    }
    const header = req.headers[PAYMENT_SIGNATURE.toLowerCase()];
    if (typeof header !== "string") {
      challenge("payment_required");
      return;
    }
    let request: FacilitatorRequest;
    try {
      const payload = decodeX402Header(header, X402Payload);
      if (new URL(payload.resource.url).href !== url.href)
        throw new Error("Wrong resource");
      request = FacilitatorRequest.parse({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: policy.requirements,
      });
    } catch {
      challenge("invalid_payload");
      return;
    }
    try {
      const settled = await post("/settle", request, X402SettleResponse);
      if (!settled.success) {
        if (
          // `settlement_unresolved`: the authorization was used on-chain but no payment could be bound to it, so the
          // payer may well have paid. Never invite a second payment; a person has to look.
          [
            "unexpected_settle_error",
            "unexpected_verify_error",
            "settlement_unresolved",
          ].includes(
            settled.errorReason ?? "",
          )
        ) {
          throw new Error("Payment status could not be established");
        }
        challenge(settled.errorReason ?? "payment_failed", settled);
        return;
      }
      if (
        !settled.transaction ||
        settled.network !== policy.requirements.network ||
        settled.payer?.toLowerCase() !==
          request.paymentPayload.payload.authorization.from.toLowerCase()
      )
        throw new Error("Unexpected settlement result");
      const claim = await post(
        "/v1/x402/delivery/claim",
        request,
        DeliveryClaim,
      );
      if (
        !claim.success ||
        !claim.paymentId ||
        !claim.leaseToken ||
        !claim.leaseSeconds
      ) {
        challenge(claim.errorReason ?? "payment_replayed");
        return;
      }
      const body = { paymentId: claim.paymentId, leaseToken: claim.leaseToken };
      const delivery = (action: string) =>
        post(
          `/v1/x402/delivery/${action}`,
          body,
          z.object({ success: z.boolean() }),
        );
      let done = false;
      const stop = (action: "complete" | "release") => {
        if (done) return;
        done = true;
        clearInterval(renew);
        void delivery(action).catch(() => undefined);
      };
      const renew = setInterval(
        () => {
          void delivery("renew")
            .then((result) => {
              if (!result.success && !done) {
                stop("release");
                res.destroy();
              }
            })
            .catch(() => {
              if (!done) {
                stop("release");
                res.destroy();
              }
            });
        },
        Math.max(1000, Math.floor((claim.leaseSeconds * 1000) / 3)),
      );
      renew.unref();
      res.once("finish", () =>
        stop(
          res.statusCode >= 200 && res.statusCode < 300
            ? "complete"
            : "release",
        ),
      );
      res.once("close", () => stop("release"));
      res.setHeader(PAYMENT_RESPONSE, encodeX402Header(settled));
      res.setHeader("cache-control", "no-store");
      next();
    } catch {
      // Do not invite a new payment when the first settlement's status may be unknown.
      if (!res.headersSent) {
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(
          JSON.stringify({
            error: {
              code: "payment_status_unknown",
              message:
                "Retry the same signed payload after checking payment status.",
            },
          }),
        );
      } else res.destroy();
    }
  };
}
