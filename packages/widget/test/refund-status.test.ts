import { afterEach, expect, it, vi } from "vitest";
import { makeOrder } from "@quietpay/shared/fixtures";
import { pollOrder } from "../src/client.js";
afterEach(() => vi.unstubAllGlobals());
it.each(["partially_refunded", "refunded"] as const)("treats %s as a completed payment without polling indefinitely", async status => {
  const order = makeOrder({ status, refunded: "1000000", refundCount: 1 });
  const fetcher = vi.fn(async () => new Response(JSON.stringify(order)));
  vi.stubGlobal("fetch",fetcher);
  expect((await pollOrder("http://relayer.test",order.id,{ timeoutMs: 1 })).status).toBe(status);
  expect(fetcher).toHaveBeenCalledOnce();
});
