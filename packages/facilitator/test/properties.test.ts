import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MERCHANT_ID, setup } from "./helpers.js";

// B3 property sweep (fast-check): whatever mix of duplicate and concurrent submissions arrives, one signed
// authorization moves money at most once and leaves exactly one payment row.
describe("facilitator settlement properties", () => {
  it("N concurrent submissions over K distinct authorizations broadcast exactly K transactions and create K rows", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 12 }), async (picks) => {
        const e = setup();
        const requests = await Promise.all(picks.map((n) => e.request(n)));
        const results = await Promise.all(requests.map((r) => e.service.settle(r, MERCHANT_ID)));
        const distinct = new Set(picks).size;
        expect(e.state.sent, "a duplicate authorization was broadcast twice").toHaveLength(distinct);
        expect(e.db.raw.prepare("SELECT COUNT(*) n FROM x402_payments").get()).toEqual({ n: distinct });
        // Every success carries a transaction, and the same authorization never reports two different transactions.
        const byNonce = new Map<number, Set<string>>();
        results.forEach((res, i) => {
          if (res.success) {
            expect(res.transaction).toMatch(/^0x[0-9a-f]{64}$/);
            byNonce.set(picks[i]!, (byNonce.get(picks[i]!) ?? new Set()).add(res.transaction));
          }
        });
        for (const txs of byNonce.values()) expect(txs.size).toBe(1);
        e.service.stop();
        e.db.close();
      }),
      { numRuns: 40 },
    );
  });

  it("verify never changes state, for any number of repeats", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (repeats) => {
        const e = setup();
        const req = await e.request(1);
        for (let i = 0; i < repeats; i++) expect((await e.service.verify(req, MERCHANT_ID)).isValid).toBe(true);
        expect(e.state.sent).toHaveLength(0);
        expect(e.db.raw.prepare("SELECT COUNT(*) n FROM x402_payments").get()).toEqual({ n: 0 });
        e.service.stop();
        e.db.close();
      }),
      { numRuns: 20 },
    );
  });
});
