import Fastify from "fastify";
import { paywall } from "@quietpay/merchant-sdk";
import {
  type X402Policy,
  PAYMENT_REQUIRED,
  PAYMENT_RESPONSE,
} from "@quietpay/shared";
export function buildPaidApi(options: {
  policies: X402Policy[];
  facilitatorUrl: string;
  apiKey: string;
  handlers?: Record<string, () => unknown | Promise<unknown>>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header(
      "access-control-allow-headers",
      "content-type, PAYMENT-SIGNATURE",
    );
    reply.header(
      "access-control-expose-headers",
      `${PAYMENT_REQUIRED}, ${PAYMENT_RESPONSE}`,
    );
    reply.header("access-control-allow-methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
  app.get("/health", async () => ({ ok: true }));
  for (const policy of options.policies) {
    const path = new URL(policy.resource.url).pathname;
    const gate = paywall({
      facilitatorUrl: options.facilitatorUrl,
      apiKey: options.apiKey,
      policy,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    });
    app.get(path, async (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader(
        "access-control-expose-headers",
        `${PAYMENT_REQUIRED}, ${PAYMENT_RESPONSE}`,
      );
      await gate(req.raw, res, () => {
        void Promise.resolve()
          .then(
            () =>
              options.handlers?.[path]?.() ??
              (path === "/v1/quote"
                ? {
                    demo: true,
                    symbol: "WBT/USDT",
                    price: "1.000000",
                    asOf: new Date().toISOString(),
                  }
                : { demo: true, signal: "hold", source: "quietpay-demo" }),
          )
          .then((data) => {
            if (!res.destroyed) {
              res.statusCode = 200;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify(data));
            }
          })
          .catch(() => {
            if (!res.destroyed) {
              res.statusCode = 503;
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  error: {
                    code: "resource_unavailable",
                    message: "Retry the same payment payload.",
                  },
                }),
              );
            }
          });
      });
    });
  }
  return app;
}
