/**
 * GET /api/merchant/ledger/export: the merchant's on-chain ledger CSV (and its verification metadata), fetched from the
 * QuietPay ledger service (packages/indexer, GET /v1/ledger/export) with the merchant API key, which never leaves this
 * server. The dashboard authenticates with its access token or a wallet sign-in session, exactly like refunds.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

export interface LedgerProxyConfig {
  /** Base URL of the ledger service, e.g. http://127.0.0.1:8788. Unset: the route answers 503 ledger_not_configured. */
  ledgerUrl?: string;
  apiKey: string;
  dashboardToken?: string;
  acceptSession?: (token: string) => boolean;
  fetch?: typeof fetch;
  /** Largest upstream body accepted, in bytes (default 20 MB). */
  maxResponseBytes?: number;
  /** Requests allowed per credential per minute (default 6). */
  rateLimitPerMinute?: number;
  /** Clock in ms, injectable for tests. */
  now?: () => number;
}

const digest = (v: string) => createHash("sha256").update(v).digest();
const fail = (code: string, message: string) => ({ error: { code, message } });
const BLOCK = /^\d{1,15}$/;
const MAX_BLOCK_RANGE = 5_000_000;
const WINDOW_MS = 60_000;

/** True when the request carries the dashboard access token or a live wallet sign-in session. */
export function merchantAuthorized(
  authorization: string | undefined,
  config: { dashboardToken?: string; acceptSession?: (token: string) => boolean },
): boolean {
  const provided = authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
  const staticOk = !!config.dashboardToken && timingSafeEqual(digest(provided), digest(config.dashboardToken));
  const sessionOk = !!provided && (config.acceptSession?.(provided) ?? false);
  return staticOk || sessionOk;
}

export function registerLedgerProxy(app: FastifyInstance, config: LedgerProxyConfig) {
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const maxBytes = config.maxResponseBytes ?? 20 * 1024 * 1024;
  const limit = config.rateLimitPerMinute ?? 20; // the dashboard reads the ledger for the agent-payments panel too
  const hits = new Map<string, number[]>(); // sha256(bearer token) -> request times within the window
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
  app.get<{ Querystring: { fromBlock?: string; toBlock?: string } }>("/api/merchant/ledger/export", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!merchantAuthorized(req.headers.authorization, config)) return reply.code(401).send(fail("unauthorized", "Dashboard access token was not accepted."));
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
    if (limited(token)) return reply.code(429).header("retry-after", "60").send(fail("rate_limited", "Too many ledger exports. Try again in a minute."));
    if (!config.ledgerUrl) return reply.code(503).send(fail("ledger_not_configured", "The ledger service is not connected to this store (set QUIETPAY_LEDGER_URL)."));

    const params = new URLSearchParams();
    for (const k of ["fromBlock", "toBlock"] as const) {
      const v = req.query?.[k];
      if (v === undefined || v === "") continue;
      if (typeof v !== "string" || !BLOCK.test(v)) return reply.code(400).send(fail("invalid_request", `${k} must be a block number.`));
      params.set(k, v);
    }
    const from = params.get("fromBlock"), to = params.get("toBlock");
    if (from !== null && to !== null && (Number(to) < Number(from) || Number(to) - Number(from) > MAX_BLOCK_RANGE))
      return reply.code(400).send(fail("invalid_request", `toBlock must be at least fromBlock and at most ${MAX_BLOCK_RANGE} blocks after it.`));
    const url = `${config.ledgerUrl.replace(/\/+$/, "")}/v1/ledger/export${params.size ? `?${params}` : ""}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers: { authorization: `Bearer ${config.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch {
      return reply.code(503).send(fail("ledger_unavailable", "The ledger service is not reachable yet. It may still be syncing the chain; try again in a minute."));
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return reply.code(502).send(fail("ledger_unavailable", "The ledger service returned an unusable export."));
    }
    if (text.length > maxBytes || Number(res.headers.get("content-length") ?? 0) > maxBytes)
      return reply.code(502).send(fail("ledger_unavailable", "The ledger export is too large; request a smaller block range."));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const body = parsed as { csv?: unknown; meta?: unknown; error?: { message?: unknown } } | undefined;
    if (!res.ok || typeof body?.csv !== "string" || typeof body.meta !== "object" || !body.meta) {
      const status = res.status === 400 ? 400 : 502;
      const msg = typeof body?.error?.message === "string" ? body.error.message.slice(0, 200) : "The ledger service returned an unusable export.";
      return reply.code(status).send(fail(status === 400 ? "invalid_request" : "ledger_unavailable", msg));
    }
    return { csv: body.csv, meta: body.meta };
  });
}
