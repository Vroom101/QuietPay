import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerLedgerProxy, type LedgerProxyConfig } from "../server/ledger-proxy.js";

const TOKEN = "t".repeat(40);
const KEY = "merchant-api-key";
const meta = { layout: "event-journal-v1", fromBlock: 1, toBlock: 9 };

function make(over: Partial<LedgerProxyConfig> = {}, upstream?: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; auth: string | null }[] = [];
  const app = Fastify();
  registerLedgerProxy(app, {
    ledgerUrl: "http://ledger.test/",
    apiKey: KEY,
    dashboardToken: TOKEN,
    acceptSession: (t) => t === "session-ok",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
      return upstream ? upstream(String(url), init) : Response.json({ csv: "date_utc,source\n", meta });
    }) as typeof fetch,
    ...over,
  });
  return { app, calls };
}
const get = (app: ReturnType<typeof Fastify>, url: string, auth?: string) =>
  app.inject({ method: "GET", url, headers: auth ? { authorization: `Bearer ${auth}` } : {} });

describe("merchant ledger export proxy", () => {
  it("returns the CSV and metadata for the dashboard token, sending the API key only upstream", async () => {
    const { app, calls } = make();
    const r = await get(app, "/api/merchant/ledger/export", TOKEN);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ csv: "date_utc,source\n", meta });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual([{ url: "http://ledger.test/v1/ledger/export", auth: `Bearer ${KEY}` }]);
    expect(r.body).not.toContain(KEY);
  });

  it("accepts a wallet sign-in session and forwards a validated block range", async () => {
    const { app, calls } = make();
    const r = await get(app, "/api/merchant/ledger/export?fromBlock=10&toBlock=20", "session-ok");
    expect(r.statusCode).toBe(200);
    expect(calls[0]!.url).toBe("http://ledger.test/v1/ledger/export?fromBlock=10&toBlock=20");
  });

  it.each([undefined, "wrong", KEY, ""])("refuses credential %s without calling upstream", async (auth) => {
    const { app, calls } = make();
    const r = await get(app, "/api/merchant/ledger/export", auth);
    expect(r.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses when no static token is configured and the session check fails", async () => {
    const { app } = make({ dashboardToken: undefined });
    expect((await get(app, "/api/merchant/ledger/export", TOKEN)).statusCode).toBe(401);
  });

  it.each(["abc", "-1", "1e5", "1;rm", "1".repeat(16)])("rejects a bad block number %s", async (b) => {
    const { app, calls } = make();
    const r = await get(app, `/api/merchant/ledger/export?fromBlock=${encodeURIComponent(b)}`, TOKEN);
    expect(r.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("explains a missing ledger service", async () => {
    const { app } = make({ ledgerUrl: undefined });
    const r = await get(app, "/api/merchant/ledger/export", TOKEN);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("ledger_not_configured");
  });

  it("reports an unreachable (still syncing) ledger as 503", async () => {
    const { app } = make({}, () => { throw new TypeError("fetch failed"); });
    const r = await get(app, "/api/merchant/ledger/export", TOKEN);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("ledger_unavailable");
  });

  it("turns an upstream failure or malformed body into 502", async () => {
    for (const res of [new Response("nope", { status: 500 }), Response.json({ csv: 1, meta }), Response.json({ csv: "x" })]) {
      const { app } = make({}, () => res);
      const r = await get(app, "/api/merchant/ledger/export", TOKEN);
      expect(r.statusCode).toBe(502);
    }
  });
});
