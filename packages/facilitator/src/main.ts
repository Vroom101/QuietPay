import {
  Db,
  makeChain,
  RelayerService,
  buildServer,
  preflight,
  WebhookWorker,
} from "@quietpay/relayer/core";
import { loadConfig } from "./config.js";
import { FacilitatorService } from "./service.js";
import { registerFacilitator } from "./server.js";
const cfg = loadConfig(),
  log = (message: string, details?: Record<string, unknown>) =>
    console.log(JSON.stringify({ message, ...details }));
log("chain preflight", await preflight(cfg.relay));
const db = new Db(cfg.relay.databasePath),
  chain = makeChain({
    rpcUrl: cfg.relay.rpcUrl,
    chainId: cfg.relay.chainId,
    router: cfg.relay.router,
    relayerKey: cfg.relay.relayerKey,
    nonceFloor: () => db.nonceFloor(),
  });
const relayer = new RelayerService({ cfg: cfg.relay, db, chain, log }),
  facilitator = new FacilitatorService(relayer, { ...cfg, log });
const worker = new WebhookWorker(db, cfg.relay.webhookSecret),
  app = buildServer(relayer);
await registerFacilitator(app, facilitator);
app.addHook("onClose", async () => {
  relayer.stopMonitor();
  facilitator.stop();
  worker.stop();
});
relayer.startMonitor();
facilitator.start();
worker.start();
await app.listen({ host: "0.0.0.0", port: cfg.relay.port });
log("combined relayer/facilitator listening", { port: cfg.relay.port });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
