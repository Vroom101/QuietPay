import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  buildAgentAuthorization,
  encodeX402Header,
  decodeX402Header,
  X402Required,
  X402SettleResponse,
  makePaidPolicies,
} from "../src/x402.js";
const payer = privateKeyToAccount(("0x" + "a1".repeat(32)) as `0x${string}`);
const policies = makePaidPolicies({
  baseUrl: "https://api.test",
  merchantId: "0x" + "01".repeat(32),
  payTo: "0x" + "22".repeat(20),
  asset: "0x" + "33".repeat(20),
  chainId: 1874,
  name: "Tether USD",
  version: "1",
});
describe("x402 v2 schemas and signing", () => {
  it("encodes a structured base64 challenge including Unicode descriptions", () => {
    const body = {
      x402Version: 2,
      resource: {
        ...policies[0]!.resource,
        description: "Price " + String.fromCharCode(0x2713),
      },
      accepts: [policies[0]!.requirements],
    };
    expect(decodeX402Header(encodeX402Header(body), X402Required)).toEqual(
      body,
    );
  });
  it("rejects malformed, oversized and noncanonical headers", () => {
    for (const header of ["not base64", "!!!!", "e30", "A".repeat(8196)])
      expect(() => decodeX402Header(header, X402Required)).toThrow();
    expect(() => encodeX402Header({ data: "a".repeat(9000) })).toThrow("8 KiB");
  });
  it("signs direct agent transfers under the token domain", async () => {
    const td = buildAgentAuthorization({
      from: payer.address,
      to: policies[0]!.requirements.payTo as `0x${string}`,
      value: 10000n,
      validAfter: 0n,
      validBefore: 1800000060n,
      nonce: ("0x" + "04".repeat(32)) as `0x${string}`,
    });
    expect(td.primaryType).toBe("TransferWithAuthorization");
    expect(
      await recoverTypedDataAddress({
        ...td,
        signature: await payer.signTypedData(td),
      }),
    ).toBe(payer.address);
  });
  it("requires the broadcast hash when settlement is pending", () => {
    expect(() =>
      X402SettleResponse.parse({
        success: false,
        errorReason: "settlement_pending",
        transaction: "",
        network: "eip155:1874",
      }),
    ).toThrow();
  });
  it("refuses a public URL with credentials or an ambiguous path", () => {
    expect(() =>
      makePaidPolicies({
        baseUrl: "https://user:pass@api.test/a",
        merchantId: "0x" + "01".repeat(32),
        payTo: "0x" + "22".repeat(20),
        asset: "0x" + "33".repeat(20),
        chainId: 1874,
        name: "Tether USD",
        version: "1",
      }),
    ).toThrow();
  });
});
