import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { makeChain } from "./chain.js";
import { RelayerService } from "./service.js";
import { buildServer } from "./server.js";
import { WebhookWorker } from "./webhooks.js";

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// Scaling note: several processes may share this one SQLite file (claims are owner-scoped and every
// transition is compare-and-set), but each process manages the relayer key's nonce on its own. Run one
// process per relayer key, or put a shared lock around signing/sending, before scaling horizontally.
const cfg = loadConfig();
const db = new Db(cfg.databasePath);
const chain = makeChain({ rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, router: cfg.router, relayerKey: cfg.relayerKey });
const svc = new RelayerService({ cfg, db, chain, log });
const worker = new WebhookWorker(db, cfg.webhookSecret, undefined, undefined, log, { allowPrivate: cfg.allowPrivateWebhooks });

svc.recoverPending();
// Every RECONCILE_INTERVAL_SECONDS (30 s): heartbeat, sweep stale claims, and resolve every signed tx that
// is still pending or broadcast_unknown (receipt, replaced/dropped, or rebroadcast-then-fail at max age).
svc.startReconciler();
void svc.reconcile().catch((e) => log("reconcile error", { err: String((e as Error).message) }));
worker.start();

const app = buildServer(svc);
await app.listen({ port: cfg.port, host: "0.0.0.0" });
log("relayer listening", { port: cfg.port, router: cfg.router, relayer: chain.relayerAddress });
