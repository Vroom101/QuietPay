import {
  AgentError,
  type createAgent,
  type PaymentLog,
} from "@quietpay/agent-client";

/** Scripted decision: inspect a quote, then buy a signal. Each endpoint is a separate payment. */
export async function runDemo(
  agent: ReturnType<typeof createAgent>,
  baseUrl: string,
  options: {
    emit?: (entry: {
      step: string;
      data: unknown;
      payment: PaymentLog;
    }) => void;
    retryDelayMs?: number;
    maxRetries?: number;
  } = {},
) {
  const results: { step: string; data: unknown; payment: PaymentLog }[] = [];
  for (const step of ["quote", "signal"]) {
    let response: Response | undefined, paymentId: `0x${string}` | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        response = paymentId
          ? await agent.retry(paymentId)
          : await agent.fetch(new URL(`/v1/${step}`, baseUrl).href);
        break;
      } catch (error) {
        if (
          !(error instanceof AgentError) ||
          !error.paymentId ||
          !["payment_pending", "payment_status_unknown"].includes(error.code) ||
          attempt >= (options.maxRetries ?? 10)
        )
          throw error;
        paymentId = error.paymentId;
        await new Promise((resolve) =>
          setTimeout(resolve, options.retryDelayMs ?? 1000),
        );
      }
    }
    if (!response.ok)
      throw new Error(`Resource failed: HTTP ${response.status}`);
    const payment = agent.payments
      .filter(
        (p) => p.url === new URL(`/v1/${step}`, baseUrl).href && p.delivered,
      )
      .at(-1);
    if (!payment?.transaction)
      throw new Error(
        "Demo requires a paid response with a settlement receipt",
      );
    const entry = { step, data: (await response.json()) as unknown, payment };
    results.push(entry);
    options.emit?.(entry);
  }
  return results;
}
