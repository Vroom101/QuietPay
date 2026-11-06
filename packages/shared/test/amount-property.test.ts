import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { InvalidAmountError, formatUsdt, parseUsdt, parseUsdtAllowZero } from "../src/index.js";

const MAX = 1_000_000_000n * 10n ** 6n;

describe("amount properties", () => {
  it("format then parse returns the same base units for every allowed amount", () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: MAX }), (v) => parseUsdt(formatUsdt(v)) === v));
  });

  it("parse then format is the identity on canonical six-place strings", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: MAX }), (v) => {
        const s = formatUsdt(v);
        return formatUsdt(parseUsdt(s)) === s;
      }),
    );
  });

  it("never accepts more than 6 decimal places, whatever the digits", () => {
    fc.assert(
      fc.property(fc.nat(999), fc.stringMatching(/^[0-9]{7,12}$/), (w, frac) => {
        expect(() => parseUsdt(`${w + 1}.${frac}`)).toThrow(InvalidAmountError);
      }),
    );
  });

  it("rejects anything that is not a plain ASCII decimal", () => {
    const bad = fc.oneof(
      fc.constantFrom("", " 1", "1 ", "+1", "-1", "1e6", "0x10", "1,000", "01", "１２", "1\u0000", "1.", ".5", "NaN", "Infinity", "٣"),
      fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(s)),
    );
    fc.assert(
      fc.property(bad, (s) => {
        expect(() => parseUsdt(s)).toThrow(InvalidAmountError);
        expect(() => parseUsdtAllowZero(s)).toThrow(InvalidAmountError);
      }),
    );
  });

  it("is fast on very long hostile input (no catastrophic regex)", () => {
    const t0 = Date.now();
    for (const s of ["1".repeat(200_000), "1." + "0".repeat(200_000), "0".repeat(200_000) + "x"]) {
      expect(() => parseUsdt(s)).toThrow(InvalidAmountError);
    }
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("rejects non-string input such as JSON numbers", () => {
    for (const v of [1, 1.5, null, undefined, {}, [], 10n] as unknown[]) {
      expect(() => parseUsdt(v as string)).toThrow();
    }
  });
});
