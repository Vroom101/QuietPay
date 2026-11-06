import { it, expect, vi } from "vitest";
import { AgentError, type createAgent } from "@quietpay/agent-client";
import { runDemo } from "../src/demo.js";
it("retries a pending payment by id and prints two paid receipts", async () => {
  const id = "0x" + "01".repeat(32),
    hash = "0x" + "02".repeat(32);
  const payments = ["quote", "signal"].map((step) => ({
    id,
    url: `https://api.example/v1/${step}`,
    delivered: true,
    transaction: hash,
  }));
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(
      new AgentError("payment_pending", "pending", id as `0x${string}`),
    )
    .mockResolvedValueOnce(new Response("{}"));
  const retry = vi.fn().mockResolvedValue(new Response("{}")),
    emit = vi.fn();
  const results = await runDemo(
    { fetch, retry, payments } as unknown as ReturnType<typeof createAgent>,
    "https://api.example",
    { retryDelayMs: 1, emit },
  );
  expect(retry).toHaveBeenCalledWith(id);
  expect(results).toHaveLength(2);
  expect(emit).toHaveBeenCalledTimes(2);
});
it("does not retry a refused budget", async () => {
  const fetch = vi
      .fn()
      .mockRejectedValue(new AgentError("budget_exceeded", "too expensive")),
    retry = vi.fn();
  await expect(
    runDemo(
      { fetch, retry } as unknown as ReturnType<typeof createAgent>,
      "https://api.example",
    ),
  ).rejects.toMatchObject({ code: "budget_exceeded" });
  expect(retry).not.toHaveBeenCalled();
});
