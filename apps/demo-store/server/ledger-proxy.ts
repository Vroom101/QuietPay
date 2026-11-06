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
}

const digest = (v: string) => createHash("sha256").update(v).digest();
const fail = (code: string, message: string) => ({ error: { code, message } });
const BLOCK = /^\d{1,15}$/;

export function registerLedgerProxy(app: FastifyInstance, config: LedgerProxyConfig) {
  const doFetch = config.fetch ?? fetch;
  app.get<{ Querystring: { fromBlock?: string; toBlock?: string } }>("/api/merchant/ledger/export", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const provided = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
    const staticOk = !!config.dashboardToken && timingSafeEqual(digest(provided), digest(config.dashboardToken));
    const sessionOk = !!provided && (config.acceptSession?.(provided) ?? false);
    if (!staticOk && !sessionOk) return reply.code(401).send(fail("unauthorized", "Dashboard access token was not accepted."));
    if (!config.ledgerUrl) return reply.code(503).send(fail("ledger_not_configured", "The ledger service is not connected to this store (set QUIETPAY_LEDGER_URL)."));

    const params = new URLSearchParams();
    for (const k of ["fromBlock", "toBlock"] as const) {
      const v = req.query?.[k];
      if (v === undefined || v === "") continue;
      if (typeof v !== "string" || !BLOCK.test(v)) return reply.code(400).send(fail("invalid_request", `${k} must be a block number.`));
      params.set(k, v);
    }
    const url = `${config.ledgerUrl.replace(/\/+$/, "")}/v1/ledger/export${params.size ? `?${params}` : ""}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers: { authorization: `Bearer ${config.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch {
      return reply.code(503).send(fail("ledger_unavailable", "The ledger service is not reachable yet. It may still be syncing the chain; try again in a minute."));
    }
    const body = (await res.json().catch(() => undefined)) as { csv?: unknown; meta?: unknown; error?: { message?: unknown } } | undefined;
    if (!res.ok || typeof body?.csv !== "string" || typeof body.meta !== "object" || !body.meta) {
      const status = res.status === 400 ? 400 : 502;
      const msg = typeof body?.error?.message === "string" ? body.error.message.slice(0, 200) : "The ledger service returned an unusable export.";
      return reply.code(status).send(fail(status === 400 ? "invalid_request" : "ledger_unavailable", msg));
    }
    return { csv: body.csv, meta: body.meta };
  });
}
