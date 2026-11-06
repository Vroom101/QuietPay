import { describe, expect, it } from "vitest";
import {
  InvalidAmountError,
  formatUsdt,
  formatUsdtShort,
  parseUsdt,
  parseUsdtAllowZero,
} from "../src/amount.js";

/** Runtime-only helper: lets tests pass non-string values without widening the public types. */
const untyped = (v: unknown) => v as string;

/** Asserts that `fn` throws an InvalidAmountError with the stable code "invalid_amount". */
function expectInvalidAmount(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(InvalidAmountError);
  expect((caught as InvalidAmountError).code).toBe("invalid_amount");
}

describe("parseUsdt (6 decimals, default)", () => {
  it.each([
    ["1", 1_000_000n],
    ["0.000001", 1n],
    ["999999.999999", 999_999_999_999n],
    ["0.5", 500_000n],
    ["25.5", 25_500_000n],
    ["1.10", 1_100_000n],
    ["1000000000", 1_000_000_000_000_000n],
  ] as const)("parses %j to %s base units", (input, expected) => {
    expect(parseUsdt(input)).toBe(expected);
  });

  it.each([
    "1.1234569",
    "-1",
    "1e6",
    ".5",
    "5.",
    "1,000",
    " 1",
    "1 ",
    "01",
    "0",
    "0.0000000",
    "0.000000",
    "abc",
    "",
    "+1",
    "0x10",
    "1.",
    "1..2",
    "1000000000.000001",
    "1000000001",
  ])("rejects %j with invalid_amount", (input) => {
    expectInvalidAmount(() => parseUsdt(input));
  });

  it.each([
    ["number", 1],
    ["null", null],
    ["undefined", undefined],
    ["bigint", 1n],
  ])("rejects a %s input with invalid_amount", (_label, input) => {
    expectInvalidAmount(() => parseUsdt(untyped(input)));
  });
});

describe("parseUsdtAllowZero", () => {
  it.each([
    ["0", 0n],
    ["0.000000", 0n],
  ])("accepts %j as %s", (input, expected) => {
    expect(parseUsdtAllowZero(input)).toBe(expected);
  });

  it.each(["0.0000000", "-0", "00"])("rejects %j with invalid_amount", (input) => {
    expectInvalidAmount(() => parseUsdtAllowZero(input));
  });
});

describe("decimals are a parameter, not hardcoded", () => {
  it.each([
    ["1.1234569", 18, 1_123_456_900_000_000_000n],
    ["1", 18, 10n ** 18n],
    ["0.000001", 6, 1n],
    ["5", 0, 5n],
  ] as const)("parses %j with %i decimals to %s", (input, decimals, expected) => {
    expect(parseUsdt(input, decimals)).toBe(expected);
  });

  it.each([
    ["0.0000000000000000001", 18],
    ["0.0000001", 6],
    ["5.0", 0],
    ["5.5", 0],
  ] as const)("rejects %j with %i decimals", (input, decimals) => {
    expectInvalidAmount(() => parseUsdt(input, decimals));
  });

  it.each([
    "-1",
    "1e6",
    ".5",
    "5.",
    "1,000",
    " 1",
    "1 ",
    "01",
    "0",
    "0.0000000",
    "abc",
    "",
    "+1",
    "0x10",
    "1..2",
  ])("rejects %j with 18 decimals too", (input) => {
    expectInvalidAmount(() => parseUsdt(input, 18));
  });
});

describe("formatUsdt and round trips", () => {
  it.each([1n, 999_999n, 1_000_000n, 25_000_000n, 999_999_999_999n])(
    "round trips %s base units through parseUsdt",
    (value) => {
      expect(parseUsdt(formatUsdt(value))).toBe(value);
    },
  );

  it.each([
    [1n, "0.000001"],
    [999_999n, "0.999999"],
    [1_000_000n, "1.000000"],
    [25_000_000n, "25.000000"],
    ["50000", "0.050000"],
    [0n, "0.000000"],
  ] as const)("formats %s as %j", (value, expected) => {
    expect(formatUsdt(value)).toBe(expected);
  });

  it.each([1n, 10n ** 18n - 1n, 1_123_456_900_000_000_000n])(
    "round trips %s with 18 decimals",
    (value) => {
      expect(parseUsdt(formatUsdt(value, 18), 18)).toBe(value);
    },
  );

  it.each(["abc", "-1", "1.5"])("rejects base units %j with invalid_amount", (input) => {
    expectInvalidAmount(() => formatUsdt(input));
  });
});

describe("formatUsdtShort (lossy display only)", () => {
  // The short form must never be used for signed or stored values: it truncates, so distinct amounts collapse.
  // Use formatUsdt for anything that is signed, stored, exported or compared.
  it.each([
    [25_000_000n, undefined, "25.00"],
    [1n, undefined, "0.00"],
    [999_999n, undefined, "0.99"],
    [1_999_999n, 3, "1.999"],
    [5_000_000n, 0, "5"],
  ] as const)("formats %s (places %s) as %j", (value, places, expected) => {
    expect(places === undefined ? formatUsdtShort(value) : formatUsdtShort(value, places)).toBe(expected);
  });
});

describe("no floating point", () => {
  it("rejects a value above Number.MAX_SAFE_INTEGER because it exceeds the max", () => {
    expectInvalidAmount(() => parseUsdt("9007199254740993"));
  });

  it("parses the largest fractional value exactly", () => {
    expect(parseUsdt("999999999.999999")).toBe(999_999_999_999_999n);
  });
});
