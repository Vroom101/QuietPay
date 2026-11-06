import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { makeEnv, MERCHANT, OTHER, hash } from "./helpers.js";
import { readCsv, writeCsv } from "../../src/api/csv.js";

describe("merchant ledger HTTP API", () => {
  it("authenticates reads and verification, isolates merchants and reports tampering", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.chain.paid(3, OTHER, hash(202));
    await e.chain.refund();
    const app = buildServer(
      e.indexer,
      new Map([
        ["merchant", MERCHANT],
        ["other", OTHER],
      ]),
    );
    const auth = { authorization: "Bearer merchant" };
    try {
      for (const url of ["/v1/ledger", "/v1/ledger/export"]) {
        expect((await app.inject({ url })).statusCode).toBe(401);
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/ledger/verify",
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      expect((await app.inject({ url: "/v1/health" })).statusCode).toBe(200);
      expect(
        (await app.inject({ method: "OPTIONS", url: "/v1/ledger" })).statusCode,
      ).toBe(204);
      const ledger = await app.inject({ url: "/v1/ledger", headers: auth });
      expect(ledger.statusCode).toBe(200);
      expect(ledger.json().orders).toHaveLength(1);
      expect(ledger.json().totals.net).toBe("19.950000");
      const exported = await app.inject({
        url: "/v1/ledger/export",
        headers: auth,
      });
      expect(exported.statusCode).toBe(200);
      const bundle = exported.json();
      expect(readCsv(bundle.csv).every((r) => r.merchant_id === MERCHANT)).toBe(
        true,
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/ledger/verify",
            headers: auth,
            payload: bundle,
          })
        ).json().ok,
      ).toBe(true);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/ledger/verify",
            headers: { authorization: "Bearer other" },
            payload: bundle,
          })
        ).statusCode,
      ).toBe(403);
      const rows = readCsv(bundle.csv);
      rows[0]!.gross_usdt = "99.000000";
      const bad = await app.inject({
        method: "POST",
        url: "/v1/ledger/verify",
        headers: auth,
        payload: { ...bundle, csv: writeCsv(rows) },
      });
      expect(bad.statusCode).toBe(200);
      expect(bad.json()).toMatchObject({ ok: false, counts: { altered: 1 } });
      expect(
        (
          await app.inject({
            url: `/v1/ledger?merchantId=${OTHER}`,
            headers: auth,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            url: "/v1/ledger/export?toBlock=999",
            headers: auth,
          })
        ).statusCode,
      ).toBe(422);
    } finally {
      await app.close();
      e.db.close();
    }
  });
});
