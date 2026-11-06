import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { chainExtensions } from "../src/chain-extensions.js";
import { MERCHANT_ID, ROUTER, payer } from "./helpers.js";
describe("main router receipt compatibility", () => {
  it("maps named totalRefunded and uint32 refundCount without swapping their meanings", async () => {
    const readContract = vi.fn(async () => ({ payer: payer.address, value: 25000000n, totalRefunded: 5000000n, refundCount: 2, settled: true }));
    const pub = { getBlockNumber: vi.fn(async () => 100n), readContract } as unknown as PublicClient;
    const port = chainExtensions(pub,ROUTER,payer.address,vi.fn());
    expect(await port.getOrderReceipt(MERCHANT_ID,MERCHANT_ID)).toEqual({ payer: payer.address, value: 25000000n, refunded: 5000000n, refundCount: 2n, settled: true });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 99n }));
  });
});
