import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FacilitatorRequest, Bytes32 } from "@quietpay/shared";
import { RateLimiter } from "@quietpay/relayer/core";
import { FacilitatorService, PaymentError } from "./service.js";
export async function registerFacilitator(
  app: FastifyInstance,
  service: FacilitatorService,
) {
  await app.register(async (api) => {
    const limiter = new RateLimiter(service.relayer.cfg.rateLimitPerMinute);
    api.addHook("preHandler", async (req, reply) => {
      if (req.method === "GET") return;
      if (!limiter.allow(req.ip))
        return reply
          .code(429)
          .send({
            error: {
              code: "rate_limited",
              message: "Too many facilitator requests.",
            },
          });
      const auth = req.headers.authorization,
        id = auth?.startsWith("Bearer ")
          ? service.relayer.cfg.apiKeys.get(auth.slice(7).trim())
          : undefined;
      if (!id)
        return reply
          .code(401)
          .send({
            error: {
              code: "unauthorized",
              message: "Resource-server API key required.",
            },
          });
    });
    const merchant = (auth?: string) =>
      service.relayer.cfg.apiKeys.get(auth!.slice(7).trim())!;
    // Client errors raised by Fastify itself (oversized body, wrong content type, malformed JSON) keep their own
    // 4xx status with a fixed message; everything else from the payment code is a 400 carrying the reason code.
    api.setErrorHandler((e, _req, reply) => {
      const status = (e as { statusCode?: number }).statusCode;
      if (typeof status === "number" && status >= 400 && status <= 499 && !(e instanceof PaymentError)) {
        const code = status === 413 ? "payload_too_large" : status === 415 ? "unsupported_media_type" : "invalid_payload";
        return reply.code(status).send({ error: { code, message: "Invalid facilitator request." } });
      }
      return reply.code(400).send({
        error: {
          code: e instanceof PaymentError ? e.reason : "invalid_payload",
          message: "Invalid facilitator request.",
        },
      });
    });
    api.get("/supported", async () => ({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: `eip155:${service.relayer.cfg.chainId}`,
          extra: { assetTransferMethod: "eip3009", paymentFlow: "upfront" },
        },
      ],
      extensions: [],
      signers: {
        [`eip155:${service.relayer.cfg.chainId}`]: [
          service.relayer.chain.relayerAddress,
        ],
      },
    }));
    api.post("/verify", async (req, reply) => {
      const parsed = FacilitatorRequest.safeParse(req.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ isValid: false, invalidReason: "invalid_payload" });
      return service.verify(parsed.data, merchant(req.headers.authorization));
    });
    api.post("/settle", async (req, reply) => {
      const parsed = FacilitatorRequest.safeParse(req.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({
            success: false,
            errorReason: "invalid_payload",
            transaction: "",
            network: `eip155:${service.relayer.cfg.chainId}`,
          });
      return service.settle(parsed.data, merchant(req.headers.authorization));
    });
    api.post("/v1/x402/delivery/claim", async (req) =>
      service.claim(
        FacilitatorRequest.parse(req.body),
        merchant(req.headers.authorization),
      ),
    );
    for (const action of ["complete", "release", "renew"] as const)
      api.post(`/v1/x402/delivery/${action}`, async (req) => {
        const body = z
          .object({ paymentId: Bytes32, leaseToken: z.string().uuid() })
          .parse(req.body);
        return service.delivery(
          body.paymentId,
          body.leaseToken,
          merchant(req.headers.authorization),
          action,
        );
      });
  });
}
