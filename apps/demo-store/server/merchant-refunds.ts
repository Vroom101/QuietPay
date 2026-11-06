import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import {
  Address,
  Bytes32,
  MerchantRefundRequest,
  token,
  type RefundContext,
} from "@quietpay/shared";
import { QuietpayApiError } from "@quietpay/merchant-sdk";
import type * as Sdk from "@quietpay/merchant-sdk";
import { RefundJournal } from "./refund-journal.js";

type Hex = `0x${string}`;
export type RefundSdk = Pick<
  typeof Sdk,
  "listOrders" | "getRefundContext" | "listRefunds" | "refund"
>;
export interface MerchantRefundConfig {
  dashboardToken: string;
  router: Hex;
  refundSignerPrivateKey: Hex;
  databasePath: string;
  chainId?: number;
  tokenAddress?: Hex;
  tokenDomain?: { name: string; version: string };
}
interface MerchantConfig {
  baseUrl: string;
  apiKey: string;
  merchantId: Hex;
  refunds?: MerchantRefundConfig;
}
class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const digest = (value: string) => createHash("sha256").update(value).digest();
const timeoutFetch: typeof fetch = (url, init) =>
  fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });

export function registerMerchantRefunds(
  app: FastifyInstance,
  sdk: Partial<RefundSdk>,
  config: MerchantConfig,
) {
  const settings = config.refunds;
  let journal: RefundJournal | undefined;
  let signer: Hex | undefined;
  if (settings) {
    if (
      settings.dashboardToken.length < 32 ||
      settings.dashboardToken === config.apiKey
    )
      throw new Error(
        "Use a separate dashboard access token of at least 32 characters",
      );
    if (!settings.databasePath)
      throw new Error("A persistent merchant refund database path is required");
    Address.parse(settings.router);
    Address.parse(settings.tokenAddress ?? token.address);
    Bytes32.parse(config.merchantId);
    signer = privateKeyToAccount(settings.refundSignerPrivateKey).address;
    for (const key of [
      "listOrders",
      "getRefundContext",
      "listRefunds",
      "refund",
    ] as const)
      if (typeof sdk[key] !== "function")
        throw new Error(`Merchant SDK is missing ${key}`);
    journal = new RefundJournal(
      settings.databasePath,
      JSON.stringify([
        config.merchantId.toLowerCase(),
        settings.router.toLowerCase(),
        settings.tokenAddress?.toLowerCase() ?? token.address.toLowerCase(),
        settings.chainId ?? token.chainId,
        settings.tokenDomain ?? token.eip712Domain,
        signer.toLowerCase(),
      ]),
    );
    app.addHook("onClose", async () => journal!.close());
  }
  const client = sdk as RefundSdk;
  const common = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: timeoutFetch,
  };
  function validate(c: RefundContext, orderId: Hex) {
    if (
      c.orderId.toLowerCase() !== orderId ||
      c.merchantId.toLowerCase() !== config.merchantId.toLowerCase() ||
      c.router.toLowerCase() !== settings!.router.toLowerCase() ||
      c.chainId !== (settings!.chainId ?? token.chainId) ||
      c.token.toLowerCase() !==
        (settings!.tokenAddress ?? token.address).toLowerCase() ||
      c.domain.name !== (settings!.tokenDomain ?? token.eip712Domain).name ||
      c.domain.version !== (settings!.tokenDomain ?? token.eip712Domain).version ||
      c.refundSigner.toLowerCase() !== signer!.toLowerCase()
    )
      throw new RouteError(
        409,
        "refund_configuration_mismatch",
        "Refund configuration does not match this merchant's payment deployment.",
      );
  }
  async function view(orderId: Hex) {
    const [context, refunds] = await Promise.all([
      client.getRefundContext({ ...common, orderId }),
      client.listRefunds({ ...common, orderId }),
    ]);
    validate(context, orderId);
    const requests = journal!
      .list(orderId)
      .map((row) => journal!.view(journal!.reconcile(row, refunds)));
    return { context, refunds, requests };
  }
  const busy = new Set<string>();
  app.register(
    async (routes) => {
      routes.addHook("onRequest", async (req, reply) => {
        reply.header("cache-control", "no-store");
        if (!settings || !journal)
          return reply.code(503).send({
            error: {
              code: "refunds_not_configured",
              message: "Merchant refund access is not configured.",
            },
          });
        const provided =
          req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
        if (!timingSafeEqual(digest(provided), digest(settings.dashboardToken)))
          return reply.code(401).send({
            error: {
              code: "unauthorized",
              message: "Dashboard access token was not accepted.",
            },
          });
        // No cookies and no cross-origin allowance: deploy behind the dashboard's same-origin /api proxy.
      });
      routes.setErrorHandler((error, _req, reply) => {
        if (error instanceof RouteError)
          return reply
            .code(error.status)
            .send({ error: { code: error.code, message: error.message } });
        if (error instanceof QuietpayApiError && error.code !== "unknown") {
          const messages: Record<string, string> = {
            order_not_found:
              "This order does not belong to the configured merchant or was not found.",
            insufficient_refund_balance:
              "Fund the merchant refund wallet before requesting this refund.",
            already_settled:
              "A refund is already pending or the refund index changed. Refresh before continuing.",
            relayer_paused:
              "Refund sending is paused. Try again after the operator resumes it.",
            simulation_failed:
              "The payment cannot be refunded in its current state.",
            rate_limited: "Too many requests. Wait a moment and refresh.",
          };
          return reply.code(error.status).send({
            error: {
              code: error.code,
              message:
                messages[error.code] ??
                "The refund service rejected this request.",
            },
          });
        }
        return reply.code(502).send({
          error: {
            code: "refund_service_unavailable",
            message:
              "Could not confirm refund status. Refresh before trying again.",
          },
        });
      });
      routes.get("/orders", async () => {
        const orders = await client.listOrders(common);
        return {
          orders: orders.filter(
            (o) =>
              o.merchantId.toLowerCase() === config.merchantId.toLowerCase(),
          ),
        };
      });
      routes.get<{ Params: { id: string } }>(
        "/orders/:id/refund-context",
        async (req) => {
          const parsed = Bytes32.safeParse(req.params.id);
          if (!parsed.success)
            throw new RouteError(400, "invalid_order", "Invalid order ID.");
          return view(parsed.data.toLowerCase() as Hex);
        },
      );
      routes.post<{ Params: { id: string } }>(
        "/orders/:id/refunds",
        async (req, reply) => {
          const id = Bytes32.safeParse(req.params.id),
            body = MerchantRefundRequest.safeParse(req.body);
          if (!id.success || !body.success)
            throw new RouteError(
              400,
              "invalid_refund",
              "Use a positive base-unit amount, refund index and request UUID.",
            );
          const orderId = id.data.toLowerCase() as Hex,
            input = body.data;
          const previous = journal!.get(input.requestId);
          if (previous) {
            if (
              previous.order_id !== orderId ||
              previous.amount !== input.amount ||
              previous.refund_index !== input.refundIndex
            )
              throw new RouteError(
                409,
                "idempotency_conflict",
                "This request ID was already used for a different refund.",
              );
            const history = await client.listRefunds({ ...common, orderId });
            const record = journal!.view(journal!.reconcile(previous, history));
            return reply
              .code(["settled", "failed"].includes(record.status) ? 200 : 202)
              .send(record);
          }
          if (busy.has(orderId))
            throw new RouteError(
              409,
              "refund_in_progress",
              "A refund request for this order is already being processed.",
            );
          busy.add(orderId);
          try {
            const state = await view(orderId),
              c = state.context;
            if (
              state.requests.some((r) =>
                ["submitting", "unknown", "pending"].includes(r.status),
              ) ||
              state.refunds.some((r) => r.status === "pending")
            )
              throw new RouteError(
                409,
                "refund_in_progress",
                "Resolve the existing refund request before creating another.",
              );
            if (c.refundIndex !== input.refundIndex)
              throw new RouteError(
                409,
                "refund_index_changed",
                "Refund status changed. Refresh and review the remaining amount.",
              );
            const amount = BigInt(input.amount),
              remaining = BigInt(c.amountPaid) - BigInt(c.refunded);
            if (amount <= 0n || amount > remaining)
              throw new RouteError(
                422,
                "amount_mismatch",
                "Refund exceeds the remaining paid amount.",
              );
            if (amount > BigInt(c.refundBalance))
              throw new RouteError(
                422,
                "insufficient_refund_balance",
                "Fund the merchant refund wallet before requesting this refund.",
              );
            // Persist identity BEFORE invoking the signer. A crash never causes an automatic second authorization.
            try {
              journal!.claim(
                { ...input, orderId },
                state.refunds.map((r) => r.id),
              );
            } catch {
              throw new RouteError(
                409,
                "refund_in_progress",
                "A refund request is already recorded. Refresh to inspect it.",
              );
            }
            try {
              const refund = await client.refund({
                ...common,
                orderId,
                merchantId: config.merchantId,
                router: settings!.router,
                refundSignerPrivateKey: settings!.refundSignerPrivateKey,
                chainId: settings!.chainId,
                tokenAddress: settings!.tokenAddress,
                tokenDomain: settings!.tokenDomain,
                amount: input.amount,
                refundIndex: input.refundIndex,
              });
              if (
                refund.orderId.toLowerCase() !== orderId ||
                refund.amount !== input.amount ||
                refund.refundIndex !== input.refundIndex
              )
                throw new Error(
                  "Refund response did not match the business request",
                );
              const row = journal!.update(
                input.requestId,
                refund.status,
                refund,
                refund.failureCode,
              );
              return reply
                .code(refund.status === "pending" ? 202 : 200)
                .send(journal!.view(row));
            } catch (error) {
              if (
                error instanceof QuietpayApiError &&
                error.code !== "unknown" &&
                ([400, 401, 403, 404, 409, 422, 429].includes(error.status) ||
                  (error.status === 503 && error.code === "relayer_paused"))
              ) {
                journal!.update(
                  input.requestId,
                  "failed",
                  undefined,
                  error.code,
                );
                throw error;
              }
              // A lost response may already have moved funds. Do not re-sign on retry, even after restart.
              return reply
                .code(202)
                .send(
                  journal!.view(journal!.update(input.requestId, "unknown")),
                );
            }
          } finally {
            busy.delete(orderId);
          }
        },
      );
    },
    { prefix: "/api/merchant" },
  );
}
