import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ERROR_HTTP_STATUS, errorBody, type ErrorCode } from "./errors.js";
import { CreateOrderRequest, RefundRequest, RelayPayRequest, type Order } from "./schemas.js";
import { InvalidAmountError, parseUsdt } from "./amount.js";
import {
  FIXTURE_PAYER,
  FIXTURE_ROUTER,
  FIXTURE_RELAYER,
  FIXTURE_TX_HASH,
  makeOrder,
  orderSettled,
} from "./fixtures/index.js";
import { computeRefundNonce, token } from "./typed-data.js";
import { FIXTURE_REFUND_SIGNER, FIXTURE_REFUND_TX_HASH } from "./fixtures/index.js";

/**
 * Canned relayer for building frontends before the real service exists.
 * Magic order amounts trigger error paths:
 *   amount ends in 0001 -> relay returns simulation_failed
 *   amount ends in 0002 -> relay returns rate_limited
 * Refunds: GET /v1/orders/:id/refund-quote?amount= and POST /v1/refund (any bearer key accepted).
 *   refund amount ends in 0001 -> insufficient_refund_balance; over-refund -> amount_mismatch;
 *   no refund on an order that is not settled -> order_not_found.
 * Fixed orders: GET /v1/orders/0xabab...ab returns a settled order.
 */
export function createMockRelayer(opts: { settleAfterMs?: number } = {}): Server {
  const settleAfterMs = opts.settleAfterMs ?? 1500;
  const orders = new Map<string, Order>([[orderSettled.id.toLowerCase(), orderSettled]]);
  const refundCounts = new Map<string, number>();

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, code: ErrorCode) => send(res, ERROR_HTTP_STATUS[code], errorBody(code));
  const readJson = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve(undefined);
        }
      });
    });

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") return send(res, 204, {});

    if (req.method === "GET" && url.pathname === "/v1/health") {
      return send(res, 200, {
        ok: true,
        chainId: token.chainId,
        router: FIXTURE_ROUTER,
        token: token.address,
        relayer: FIXTURE_RELAYER,
        paused: false,
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/orders") {
      const body = (await readJson(req)) as Record<string, unknown> | undefined;
      // A decimal amount ("25.5") is parsed strictly; seven decimals or any malformed value is invalid_amount.
      if (body && typeof body.amount === "string" && body.amount.includes(".")) {
        try {
          body.amount = parseUsdt(body.amount).toString();
        } catch (e) {
          if (e instanceof InvalidAmountError) return fail(res, "invalid_amount");
          throw e;
        }
      }
      const parsed = CreateOrderRequest.safeParse(body);
      if (!parsed.success) return fail(res, parsed.error.issues.some((i) => i.path.includes("amount")) ? "invalid_amount" : "bad_signature");
      const id = ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;
      const now = Math.floor(Date.now() / 1000);
      // The fee is part of the signed nonce, so it travels with the order and never exceeds amount - 1.
      const fee = BigInt(parsed.data.amount) > 50_000n ? "50000" : "0";
      const order = makeOrder({
        id,
        amount: parsed.data.amount,
        fee,
        reference: parsed.data.reference,
        createdAt: now,
        expiresAt: now + (parsed.data.expiresInSeconds ?? 900),
      });
      orders.set(id.toLowerCase(), order);
      return send(res, 201, order);
    }

    const quoteMatch = url.pathname.match(/^\/v1\/orders\/(0x[0-9a-fA-F]{64})\/refund-quote$/);
    if (req.method === "GET" && quoteMatch) {
      const o = orders.get(quoteMatch[1]!.toLowerCase());
      const amount = url.searchParams.get("amount") ?? "";
      if (!o || o.status !== "settled") return fail(res, "order_not_found");
      if (!/^[1-9][0-9]*$/.test(amount)) return fail(res, "amount_mismatch");
      const done = BigInt(o.refundedAmount ?? "0");
      const idx = refundCounts.get(o.id.toLowerCase()) ?? 0;
      const payer = o.payer ?? FIXTURE_PAYER;
      return send(res, 200, {
        orderId: o.id,
        merchantId: o.merchantId,
        payer,
        amount,
        refundIndex: idx,
        nonce: computeRefundNonce({ merchantId: o.merchantId as `0x${string}`, orderId: o.id as `0x${string}`, payer: payer as `0x${string}`, amount: BigInt(amount), refundIndex: idx }),
        totalRefunded: done.toString(),
        remaining: (BigInt(o.amount) - done).toString(),
        refundSigner: FIXTURE_REFUND_SIGNER,
        chainId: token.chainId,
        token: token.address,
        router: FIXTURE_ROUTER,
        domain: token.eip712Domain,
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/refund") {
      if (!req.headers.authorization?.startsWith("Bearer ")) return send(res, 401, errorBody("bad_signature", "Invalid API key."));
      const parsed = RefundRequest.safeParse(await readJson(req));
      if (!parsed.success) return fail(res, "bad_signature");
      const o = orders.get(parsed.data.orderId.toLowerCase());
      if (!o || o.status !== "settled") return fail(res, "order_not_found");
      if (parsed.data.amount.endsWith("0001")) return fail(res, "insufficient_refund_balance");
      const done = BigInt(o.refundedAmount ?? "0");
      const amt = BigInt(parsed.data.amount);
      if (done + amt > BigInt(o.amount)) return fail(res, "amount_mismatch");
      const idx = refundCounts.get(o.id.toLowerCase()) ?? 0;
      refundCounts.set(o.id.toLowerCase(), idx + 1);
      orders.set(o.id.toLowerCase(), { ...o, refundedAmount: (done + amt).toString() });
      return send(res, 200, {
        orderId: o.id,
        amount: parsed.data.amount,
        refundIndex: idx,
        totalRefunded: (done + amt).toString(),
        txHash: FIXTURE_REFUND_TX_HASH,
      });
    }

    const orderMatch = url.pathname.match(/^\/v1\/orders\/(0x[0-9a-fA-F]{64})$/);
    if (req.method === "GET" && orderMatch) {
      const o = orders.get(orderMatch[1]!.toLowerCase());
      return o ? send(res, 200, o) : fail(res, "order_not_found");
    }

    if (req.method === "POST" && url.pathname === "/v1/relay/pay") {
      const parsed = RelayPayRequest.safeParse(await readJson(req));
      if (!parsed.success) return fail(res, "bad_signature");
      const o = orders.get(parsed.data.orderId.toLowerCase());
      if (!o) return fail(res, "order_not_found");
      if (o.status === "settled") return fail(res, "already_settled");
      if (o.amount.endsWith("0001")) return fail(res, "simulation_failed");
      if (o.amount.endsWith("0002")) return fail(res, "rate_limited");
      const pending: Order = { ...o, status: "pending", payer: parsed.data.payer, txHash: FIXTURE_TX_HASH };
      orders.set(o.id.toLowerCase(), pending);
      setTimeout(() => {
        orders.set(o.id.toLowerCase(), {
          ...pending,
          status: "settled",
          settledAt: Math.floor(Date.now() / 1000),
          payer: parsed.data.payer ?? FIXTURE_PAYER,
          explorerUrl: `https://sepolia.whitechain.io/tx/${FIXTURE_TX_HASH}`,
        });
      }, settleAfterMs);
      return send(res, 200, { orderId: o.id, status: "pending", txHash: FIXTURE_TX_HASH });
    }

    send(res, 404, { error: { code: "order_not_found", message: "no such route in mock relayer" } });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  createMockRelayer().listen(port, () => console.log(`mock relayer on http://localhost:${port}`));
}
