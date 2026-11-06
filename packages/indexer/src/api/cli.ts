import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redactSecrets } from "../redact.js";
import { loadConfig } from "./config.js";
import { makeReader } from "./chain.js";
import { IndexDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { verifyExport } from "./verifier.js";
import { BlockNumber, Hash } from "./model.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      merchant: { type: "string" },
      out: { type: "string" },
      csv: { type: "string" },
      meta: { type: "string" },
    },
  });
  const command = positionals[0];
  if (!["sync", "export", "verify"].includes(command ?? ""))
    throw new Error(
      "Usage: cli sync | export --out export [--from N --to N --merchant 0x...] | verify --csv export.csv --meta export.meta.json",
    );
  const cfg = loadConfig(),
    chain = makeReader(cfg.rpcUrl, cfg.scope);
  const fromBlock =
    values.from === undefined
      ? undefined
      : BlockNumber.parse(Number(values.from));
  const toBlock =
    values.to === undefined ? undefined : BlockNumber.parse(Number(values.to));
  const merchantId =
    values.merchant === undefined
      ? undefined
      : Hash.parse(values.merchant).toLowerCase();
  if (command === "verify") {
    if (!values.csv || !values.meta)
      throw new Error("verify requires --csv and --meta");
    const bundle = {
      csv: await readFile(values.csv, "utf8"),
      meta: JSON.parse(await readFile(values.meta, "utf8")),
    };
    const result = await verifyExport(chain, cfg.scope, bundle, {
      merchantId,
      fromBlock,
      toBlock,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const db = new IndexDb(cfg.databasePath, cfg.scope),
    indexer = new Indexer(db, chain, cfg.scope);
  try {
    // CLI catches up fully; each sync remains bounded to 20 pages.
    do {
      await indexer.sync();
    } while (
      db.cursor <
      Math.max(
        cfg.scope.deploymentBlock - 1,
        (indexer.head ?? 0) - cfg.scope.confirmations,
      )
    );
    if (command === "sync") {
      console.log(JSON.stringify({ indexedThrough: db.cursor }));
      return;
    }
    const bundle = await indexer.export({ fromBlock, toBlock, merchantId }),
      prefix = values.out ?? "export";
    await mkdir(dirname(prefix), { recursive: true });
    await writeFile(`${prefix}.csv`, bundle.csv, { flag: "wx" });
    await writeFile(
      `${prefix}.meta.json`,
      JSON.stringify(bundle.meta, null, 2) + "\n",
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        csv: `${prefix}.csv`,
        meta: `${prefix}.meta.json`,
        ...bundle.meta,
      }),
    );
  } finally {
    await indexer.stop();
    db.close();
  }
}
main().catch((e) => {
  console.error(redactSecrets((e as Error).message ?? String(e), [process.env.RPC_URL]));
  process.exitCode = 1;
});
