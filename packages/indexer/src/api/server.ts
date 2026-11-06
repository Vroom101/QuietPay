import { redactSecrets } from "../redact.js";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { Indexer } from "./indexer.js";
import { ExportMetaSchema } from "./model.js";
import { verifyExport } from "./verifier.js";

export function buildServer(indexer: Indexer, apiKeys: Map<string, string>) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "content-type, authorization");
    reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
  const merchant = (req: FastifyRequest, reply: FastifyReply) => {
    const value = req.headers.authorization;
    const id = value?.startsWith("Bearer ")
      ? apiKeys.get(value.slice(7).trim())
      : undefined;
    if (!id) {
      void reply
        .code(401)
        .send({
          error: {
            code: "unauthorized",
            message: "Merchant API key required.",
          },
        });
      return;
    }
    return id.toLowerCase();
  };
  app.setErrorHandler((error, _req, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    const code =
      error instanceof ZodError
        ? 400
        : status === 400 || status === 413
          ? status
          : 422;
    return reply
      .code(code)
      .send({
        error: {
          code: code === 400 ? "invalid_request" : "ledger_unavailable",
          message: redactSecrets((error as Error).message),
        },
      });
  });
  app.get("/v1/health", async () => ({
    ok: indexer.head !== null && indexer.lastError === null,
    caughtUp:
      indexer.head !== null &&
      indexer.db.cursor >= indexer.head - indexer.scope.confirmations,
    chainId: indexer.scope.chainId,
    indexedThrough: indexer.db.cursor,
    head: indexer.head,
    confirmations: indexer.scope.confirmations,
    lastError: indexer.lastError,
  }));
  app.get("/v1/ledger", async (req, reply) => {
    const id = merchant(req, reply);
    if (!id) return reply;
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(1000).default(100) })
      .strict()
      .parse(req.query);
    return indexer.ledger(id, q.limit);
  });
  app.get("/v1/ledger/export", async (req, reply) => {
    const id = merchant(req, reply);
    if (!id) return reply;
    const range = z
      .object({
        fromBlock: z.coerce.number().int().nonnegative().safe().optional(),
        toBlock: z.coerce.number().int().nonnegative().safe().optional(),
      })
      .strict()
      .parse(req.query);
    return indexer.export({ ...range, merchantId: id });
  });
  app.post("/v1/ledger/verify", async (req, reply) => {
    const id = merchant(req, reply);
    if (!id) return reply;
    const body = z
      .object({ csv: z.string().max(1_500_000), meta: ExportMetaSchema })
      .strict()
      .parse(req.body);
    if (body.meta.merchantId?.toLowerCase() !== id)
      return reply
        .code(403)
        .send({
          error: {
            code: "forbidden",
            message: "Export belongs to a different merchant.",
          },
        });
    return verifyExport(indexer.chain, indexer.scope, body, { merchantId: id });
  });
  app.addHook("onClose", async () => {
    await indexer.stop();
  });
  return app;
}
