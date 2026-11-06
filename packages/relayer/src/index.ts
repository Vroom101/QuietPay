import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { makeChain } from "./chain.js";
import { RelayerService } from "./service.js";
import { buildServer } from "./server.js";
import { WebhookWorker } from "./webhooks.js";

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const cfg = loadConfig();
const db = new Db(cfg.databasePath);
const chain = makeChain({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, router: cfg.router, relayerKey: cfg.relayerKey });
const svc = new RelayerService({ cfg, db, chain, log });
const worker = new WebhookWorker(db, cfg.webhookSecret, undefined, undefined, log, { allowPrivate: cfg.allowPrivateWebhooks });

svc.recoverPending();
worker.start();

const app = buildServer(svc);
await app.listen({ port: cfg.port, host: "0.0.0.0" });
log("relayer listening", { port: cfg.port, router: cfg.router, relayer: chain.relayerAddress });
