import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import {
  AdminPauseRequest,
  CreateOrderRequest,
  QuietpayError,
  RelayPayRequest,
  errorBody,
  type ErrorCode,
} from "@quietpay/shared";
import type { RelayerService } from "./service.js";
import { RateLimiter } from "./ratelimit.js";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

export function buildServer(svc: RelayerService): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "content-type, authorization");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof QuietpayError) return reply.code(err.status).send(err.toBody());
    if (err instanceof ZodError) {
      // Malformed requests are treated like a bad signature or amount; they never reach the chain.
      const code: ErrorCode = err.issues.some((i) => i.path.includes("amount")) ? "amount_mismatch" : "bad_signature";
      return reply.code(400).send(errorBody(code, "The request was not valid."));
    }
    // Fastify client errors (bad JSON, oversized body, unsupported content type) keep their status.
    // Only fixed, safe messages are sent; the Fastify message is never echoed back.
    const e = err as { statusCode?: number };
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode <= 499) {
      const msg = e.statusCode === 415 ? "Unsupported content type. Send application/json." : "The request was not valid.";
      return reply.code(e.statusCode).send(errorBody("bad_signature", msg));
    }
    svc["log"]?.("unhandled", { err: String((err as Error).message).slice(0, 300) });
    return reply.code(500).send({ error: { code: "simulation_failed", message: "Something went wrong on our side." } });
  });

  const merchantFromKey = (req: FastifyRequest, reply: FastifyReply) => {
    const key = bearer(req);
    const merchant = key ? svc.cfg.apiKeys.get(key) : undefined;
    if (!merchant) {
      void reply.code(401).send({ error: { code: "bad_signature", message: "Invalid API key." } });
      return undefined;
    }
    return merchant;
  };
  const operatorOnly = (req: FastifyRequest, reply: FastifyReply) => {
    const t = bearer(req);
    if (!t || !safeEqual(t, svc.cfg.operatorToken)) {
      void reply.code(401).send({ error: { code: "bad_signature", message: "Operator token required." } });
      return false;
    }
    return true;
  };

  // Health is unauthenticated and costs RPC calls, so it gets its own small per-IP limit.
  const healthLimiter = new RateLimiter(60, 60_000);
  app.get("/v1/health", async (req) => {
    if (!healthLimiter.allow(req.ip)) throw new QuietpayError("rate_limited");
    return svc.health();
  });

  app.post("/v1/orders", async (req, reply) => {
    const merchant = merchantFromKey(req, reply);
    if (!merchant) return reply;
    const body = CreateOrderRequest.parse(req.body);
    if (body.merchantId.toLowerCase() !== merchant.toLowerCase()) {
      return reply.code(403).send({ error: { code: "bad_signature", message: "API key does not belong to this merchant." } });
    }
    const order = await svc.createOrder(body.merchantId as `0x${string}`, body);
    return reply.code(201).send(order);
  });

  app.get("/v1/orders", async (req, reply) => {
    const merchant = merchantFromKey(req, reply);
    if (!merchant) return reply;
    return { orders: svc.listOrders(merchant) };
  });

  app.get<{ Params: { id: string } }>("/v1/orders/:id", async (req) => svc.getOrder(req.params.id));

  app.post("/v1/relay/pay", async (req) => {
    const body = RelayPayRequest.parse(req.body);
    return svc.relayPay(body, { ip: req.ip });
  });

  app.get("/v1/metrics", async (req, reply) => {
    if (!operatorOnly(req, reply)) return reply;
    return svc.metrics();
  });

  app.post("/v1/admin/pause", async (req, reply) => {
    if (!operatorOnly(req, reply)) return reply;
    const { paused } = AdminPauseRequest.parse(req.body);
    svc.setLocalPaused(paused);
    return { paused };
  });

  return app;
}
