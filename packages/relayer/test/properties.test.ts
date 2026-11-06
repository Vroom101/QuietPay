import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { RateLimiter } from "../src/ratelimit.js";

// B3 property sweep (fast-check) for the relayer's rate limiter, which sits in front of every guard.
describe("RateLimiter properties", () => {
  it("never admits more than `limit` hits inside any window, for any arrival pattern", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 1, maxLength: 200 }),
        (limit, windowMs, gaps) => {
          let t = 1_000_000;
          const lim = new RateLimiter(limit, windowMs, () => t);
          const admitted: number[] = [];
          for (const gap of gaps) {
            t += gap;
            if (lim.allow("k")) admitted.push(t);
          }
          // Any `limit + 1` consecutive admitted hits must span at least one full window.
          for (let i = 0; i + limit < admitted.length; i++) expect(admitted[i + limit]! - admitted[i]!).toBeGreaterThanOrEqual(windowMs);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("keys are independent: one key hitting its limit never blocks another", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.string({ minLength: 1, maxLength: 12 }), fc.string({ minLength: 1, maxLength: 12 }), (limit, a, b) => {
        fc.pre(a !== b);
        const lim = new RateLimiter(limit, 60_000, () => 5);
        for (let i = 0; i < limit * 3; i++) lim.allow(a);
        expect(lim.allow(b)).toBe(true);
      }),
    );
  });

  it("wouldAllow never records a hit", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 1, max: 50 }), (limit, probes) => {
        const lim = new RateLimiter(limit, 60_000, () => 5);
        for (let i = 0; i < probes; i++) lim.wouldAllow("k");
        for (let i = 0; i < limit; i++) expect(lim.allow("k")).toBe(true);
        expect(lim.allow("k")).toBe(false);
      }),
    );
  });
});
