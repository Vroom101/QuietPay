import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import {
  AdminPauseRequest,
  CreateOrderRequest,
  QuietpayError,
  RelayPayRequest,
  RelayRefundRequest,
  errorBody,
  type ErrorCode,
} from "@quietpay/shared";
import type { RelayerService } from "./service.js";
import { RateLimiter, clientKey, resolveClientIp } from "./ratelimit.js";

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
  // Request timeouts: a client that trickles bytes cannot hold a socket open forever (slowloris).
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 30_000, connectionTimeout: 60_000 });
  app.server.headersTimeout = 15_000;

  // X-Forwarded-For is only read when TRUST_PROXY_HOPS > 0 (explicit opt-in for a known proxy chain).
  const ipOf = (req: FastifyRequest): string => resolveClientIp(req.ip, req.headers["x-forwarded-for"], svc.cfg.trustProxyHops ?? 0);

  // CORS. Public routes (health, order status, the relay endpoint the browser widget calls, /supported) answer any origin.
  // Authenticated routes carry a bearer key and are called server to server, so they never get a wildcard: they only
  // answer origins listed in CORS_ORIGINS (for example a merchant dashboard), echoed back with Vary: Origin.
  const publicPath = (url: string): boolean => {
    const path = url.split("?")[0] ?? "";
    return path === "/v1/health" || path === "/supported" || path === "/v1/relay/pay" || /^\/v1\/orders\/[^/]+$/.test(path);
  };
  const corsOrigins = new Set(svc.cfg.corsOrigins ?? []);
  app.addHook("onRequest", async (req, reply) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const allowListed = origin !== undefined && corsOrigins.has(origin);
    reply.header("vary", "Origin"); // the answer depends on the Origin header: shared caches must not mix them up
    if (allowListed) {
      reply.header("access-control-allow-origin", origin);
    } else if (publicPath(req.url)) {
      reply.header("access-control-allow-origin", "*");
    }
    if (allowListed || publicPath(req.url)) {
      reply.header("access-control-allow-headers", "content-type, authorization");
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  // One fixed body for unknown routes: Fastify's default would echo the requested method and path back.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "Not found." } }));

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

  // Failed bearer-token attempts (merchant key or operator token) are counted per client IP. Once an IP has used
  // up its failures, only a credential that ALREADY authenticated from that same IP within the last hour is still
  // honoured; anything else gets 429 before it is evaluated, so online guessing stays throttled while a stranger's
  // junk keys cannot lock out a legitimate merchant or the operator sharing an egress address.
  const authFailLimiter = new RateLimiter(10, 60_000);
  const authBlocked = (req: FastifyRequest) => !authFailLimiter.wouldAllow(clientKey(ipOf(req)));
  const authFailed = (req: FastifyRequest) => void authFailLimiter.allow(clientKey(ipOf(req)));

  const KNOWN_TTL_MS = 3_600_000;
  const MAX_KNOWN_IPS = 10_000;
  const MAX_IPS_PER_CREDENTIAL = 64;
  // ip key -> credential digest -> expiry (inner insertion order = age); credIps: digest -> ip keys it holds (oldest first).
  const knownGood = new Map<string, Map<string, number>>();
  const credIps = new Map<string, Set<string>>();
  const digest = (kind: string, cred: string) => createHash("sha256").update(kind).update("\0").update(cred).digest("hex");
  const isKnown = (req: FastifyRequest, d: string) => {
    const e = knownGood.get(clientKey(ipOf(req)))?.get(d);
    return e !== undefined && e > Date.now();
  };
  const forget = (ip: string, d: string) => {
    const m = knownGood.get(ip);
    if (m) {
      m.delete(d);
      if (m.size === 0) knownGood.delete(ip);
    }
    const s = credIps.get(d);
    if (s) {
      s.delete(ip);
      if (s.size === 0) credIps.delete(d);
    }
  };
  const remember = (req: FastifyRequest, d: string) => {
    const k = clientKey(ipOf(req));
    const now = Date.now();
    let s = credIps.get(d);
    if (!s) {
      s = new Set();
      credIps.set(d, s);
    }
    // Refresh recency: re-insert so the Set order is oldest-first.
    s.delete(k);
    s.add(k);
    // A credential holds at most MAX_IPS_PER_CREDENTIAL IPs: it evicts only its OWN oldest entries.
    while (s.size > MAX_IPS_PER_CREDENTIAL) forget(s.values().next().value as string, d);
    let m = knownGood.get(k);
    if (!m) {
      m = new Map();
      knownGood.set(k, m);
    }
    m.delete(d);
    m.set(d, now + KNOWN_TTL_MS);
    // Global bound: evict least recently used IPs (Map order), dropping expired entries first.
    if (knownGood.size > MAX_KNOWN_IPS) {
      for (const [ip, mm] of knownGood) {
        for (const [dd, exp] of mm) if (exp <= now) forget(ip, dd);
      }
      while (knownGood.size > MAX_KNOWN_IPS) {
        const ip = knownGood.keys().next().value as string;
        for (const dd of [...(knownGood.get(ip)?.keys() ?? [])]) forget(ip, dd);
      }
    }
    // Refresh the IP's recency in the global order.
    if (knownGood.get(k) === m) {
      knownGood.delete(k);
      knownGood.set(k, m);
    }
    while (m.size > 32) forget(k, m.keys().next().value as string);
  };

  /** Constant-time scan over every configured key (no early exit on the first hit). */
  const lookupKey = (key: string | undefined): string | undefined => {
    if (!key) return undefined;
    let found: string | undefined;
    for (const [k, m] of svc.cfg.apiKeys) if (safeEqual(k, key) && found === undefined) found = m;
    return found;
  };

  const merchantFromKey = (req: FastifyRequest, reply: FastifyReply) => {
    const key = bearer(req);
    const merchant = lookupKey(key);
    const d = key ? digest("merchant", key) : "";
    if (merchant && (!authBlocked(req) || isKnown(req, d))) {
      remember(req, d);
      return merchant;
    }
    if (authBlocked(req)) throw new QuietpayError("rate_limited");
    authFailed(req);
    void reply.code(401).send({ error: { code: "bad_signature", message: "Invalid API key." } });
    return undefined;
  };
  const operatorOnly = (req: FastifyRequest, reply: FastifyReply) => {
    const t = bearer(req);
    const valid = !!t && safeEqual(t, svc.cfg.operatorToken);
    const d = t ? digest("operator", t) : "";
    if (valid && (!authBlocked(req) || isKnown(req, d))) {
      remember(req, d);
      return true;
    }
    if (authBlocked(req)) throw new QuietpayError("rate_limited");
    authFailed(req);
    void reply.code(401).send({ error: { code: "bad_signature", message: "Operator token required." } });
    return false;
  };

  // Health is unauthenticated and costs RPC calls, so it gets its own small per-IP limit.
  const healthLimiter = new RateLimiter(60, 60_000);
  app.get("/v1/health", async (req) => {
    if (!healthLimiter.allow(clientKey(ipOf(req)))) throw new QuietpayError("rate_limited");
    return svc.health();
  });

  // Order creation is per-IP limited before the API-key check, so unauthenticated floods are counted too.
  const ordersLimiter = new RateLimiter(120, 60_000);
  app.post("/v1/orders", async (req, reply) => {
    if (!ordersLimiter.allow(clientKey(ipOf(req)))) throw new QuietpayError("rate_limited");
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
    if (!ordersLimiter.allow(clientKey(ipOf(req)))) throw new QuietpayError("rate_limited");
    const merchant = merchantFromKey(req, reply);
    if (!merchant) return reply;
    return { orders: svc.listOrders(merchant) };
  });

  app.get<{ Params: { id: string } }>("/v1/orders/:id", async (req) => svc.getOrder(req.params.id));

  app.post("/v1/relay/pay", async (req) => {
    const body = RelayPayRequest.parse(req.body);
    return svc.relayPay(body, { ip: ipOf(req) });
  });

  app.get<{ Params: { id: string } }>("/v1/orders/:id/refund-context", async (req, reply) => {
    const merchant = merchantFromKey(req, reply);
    if (!merchant) return reply;
    return svc.refunds.context(merchant as `0x${string}`, req.params.id as `0x${string}`);
  });
  app.get<{ Params: { id: string } }>("/v1/orders/:id/refunds", async (req, reply) => {
    const merchant = merchantFromKey(req, reply);
    if (!merchant) return reply;
    return { refunds: svc.refunds.list(merchant, req.params.id) };
  });
  app.post("/v1/relay/refund", async (req, reply) => {
    const merchant = merchantFromKey(req, reply);
    if (!merchant) return reply;
    return svc.refunds.submit(merchant as `0x${string}`, RelayRefundRequest.parse(req.body), ipOf(req));
  });
  app.get<{ Params: { id: string } }>("/v1/refunds/:id", async (req, reply) => {
    const merchant = merchantFromKey(req, reply);
    if (!merchant) return reply;
    return svc.refunds.get(merchant, req.params.id);
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
