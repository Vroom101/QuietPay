import { redactSecrets } from "../redact.js";
import { loadConfig } from "./config.js";
import { makeReader } from "./chain.js";
import { IndexDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { buildServer } from "./server.js";
const cfg = loadConfig();
if (!cfg.apiKeys.size)
  throw new Error(
    "Set MERCHANT_API_KEYS before starting the ledger HTTP service",
  );
const db = new IndexDb(cfg.databasePath, cfg.scope),
  indexer = new Indexer(db, makeReader(cfg.rpcUrl, cfg.scope), cfg.scope);
await indexer.sync();
const app = buildServer(indexer, cfg.apiKeys);
indexer.start(cfg.pollMs, (e) =>
  console.error("Indexer sync failed:", redactSecrets(String(e), [cfg.rpcUrl])),
);
await app.listen({ host: cfg.host, port: cfg.port });
console.log(
  JSON.stringify({
    message: "ledger listening",
    port: cfg.port,
    indexedThrough: db.cursor,
  }),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
