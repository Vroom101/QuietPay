/**
 * Gas tank proxy. The relayer pays network gas for every payment and refund out of a merchant's prepaid gas credit;
 * these routes let the dashboard read that account and credit a WBT top-up. The merchant API key stays on this server.
 *
 *   GET  /api/merchant/gas          -> GasAccount
 *   POST /api/merchant/gas/topups   { txHash } -> 201 { topUp, account }
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { merchantAuthorized } from "./ledger-proxy.js";

export interface GasTopUp { txHash: string; from: string; wei: string; block: number; creditedAt: number }
export interface GasAccount {
  merchantId: string; relayer: string; payout: string; creditedWei: string; spentWei: string; balanceWei: string;
  lowBalance: boolean; avgGasPerOrderWei: string; paymentsLeft: number | null; minConfirmations: number; topUps: GasTopUp[];
}

/** The SDK members this proxy needs; optional so an older SDK (or a stub) compiles and answers 503. */
export interface GasSdk {
  getGasAccount?: (opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) => Promise<GasAccount>;
  creditGasTopUp?: (opts: { baseUrl: string; apiKey: string; txHash: string; fetch?: typeof fetch }) => Promise<{ topUp: GasTopUp; account: GasAccount }>;
}

export interface GasTankConfig {
  baseUrl: string;
  apiKey: string;
  dashboardToken?: string;
  acceptSession?: (token: string) => boolean;
  fetch?: typeof fetch;
  /** POSTs allowed per credential per minute (default 10). */
  rateLimitPerMinute?: number;
  now?: () => number;
}

const fail = (code: string, message: string) => ({ error: { code, message } });
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const WINDOW_MS = 60_000;
/** Upstream statuses that are safe and meaningful to show the merchant as they are. */
const PASS_THROUGH = new Set([400, 403, 404, 409, 422, 429]);

export function registerGasTank(app: FastifyInstance, sdk: GasSdk, config: GasTankConfig) {
  const now = config.now ?? Date.now;
  const limit = config.rateLimitPerMinute ?? 10;
  const hits = new Map<string, number[]>();
  const limited = (token: string): boolean => {
    const t = now();
    const key = createHash("sha256").update(token).digest("hex");
    const recent = (hits.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return true;
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 1000) for (const [k, v] of hits) if (v.every((x) => t - x >= WINDOW_MS)) hits.delete(k);
    return false;
  };
  const upstreamOpts = () => ({ baseUrl: config.baseUrl, apiKey: config.apiKey, ...(config.fetch ? { fetch: config.fetch } : {}) });
  const sendError = (reply: import("fastify").FastifyReply, e: unknown) => {
    const err = e as { status?: unknown; code?: unknown; message?: unknown } | undefined;
    if (typeof err?.status === "number" && PASS_THROUGH.has(err.status) && typeof err.code === "string" && err.code !== "unknown") {
      const message = typeof err.message === "string" ? err.message.slice(0, 300) : "The gas request was refused.";
      return reply.code(err.status).send(fail(err.code, message));
    }
    return reply.code(502).send(fail("gas_unavailable", "The QuietPay relayer could not process the gas request. Try again shortly."));
  };

  app.get("/api/merchant/gas", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!merchantAuthorized(req.headers.authorization, config)) return reply.code(401).send(fail("unauthorized", "Dashboard access token was not accepted."));
    if (!sdk.getGasAccount) return reply.code(503).send(fail("gas_not_configured", "The gas tank is not available on this store's SDK version."));
    try {
      return await sdk.getGasAccount(upstreamOpts());
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post<{ Body: { txHash?: unknown } }>("/api/merchant/gas/topups", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!merchantAuthorized(req.headers.authorization, config)) return reply.code(401).send(fail("unauthorized", "Dashboard access token was not accepted."));
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
    if (limited(token)) return reply.code(429).header("retry-after", "60").send(fail("rate_limited", "Too many top-up attempts. Try again in a minute."));
    const txHash = (req.body as { txHash?: unknown } | undefined)?.txHash;
    if (typeof txHash !== "string" || !TX_HASH.test(txHash)) return reply.code(400).send(fail("invalid_request", "txHash must be a 0x-prefixed 32-byte transaction hash."));
    if (!sdk.creditGasTopUp) return reply.code(503).send(fail("gas_not_configured", "The gas tank is not available on this store's SDK version."));
    try {
      const result = await sdk.creditGasTopUp({ ...upstreamOpts(), txHash });
      return reply.code(201).send({ topUp: result.topUp, account: result.account });
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
