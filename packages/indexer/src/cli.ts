#!/usr/bin/env tsx
import { writeFilesAtomic } from "./atomic.js";
import { assertQualifyingConfig, getDeployment, getQualifyingDeployment, QUALIFYING_CHAIN_ID } from "@quietpay/shared";
import { IndexerDb } from "./db.js";
import { buildExport, indexOnce, rebuild, type IndexerConfig } from "./indexer.js";
import { getNodeChainId, makeLogSource } from "./rpc.js";

const USAGE = `quietpay-indexer <command>
  index                         catch up to the finalized head once
  watch                         loop, polling every few seconds
  rebuild                       recompute the ledger from raw events
  export --from N --to M --out FILE   write FILE (CSV) and FILE.meta.json
Env: RPC_URL CHAIN_ID USDT_ADDRESS ROUTER_ADDRESS FACILITATOR_PAYTO DATABASE_PATH CONFIRMATIONS [DEPLOY_BLOCK]`;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

/** On chain 1874 the router must be the qualifying one recorded in deployments.json. */
function assertQualifyingRouter(router: string): void {
  const q = getQualifyingDeployment();
  if (router.toLowerCase() !== q.router.toLowerCase()) {
    throw new Error(`Refusing router ${router}: on chain ${QUALIFYING_CHAIN_ID} only the qualifying router ${q.router} is accepted`);
  }
}

/** Refuses to index unless the RPC node itself reports chain 1874 and CHAIN_ID (if set) agrees with it. */
async function assertNodeChain(rpcUrl: string): Promise<void> {
  const nodeId = await getNodeChainId(rpcUrl);
  if (nodeId !== QUALIFYING_CHAIN_ID) throw new Error(`RPC node reports chain ${nodeId}; refusing (expected ${QUALIFYING_CHAIN_ID})`);
  if (process.env.CHAIN_ID !== undefined && Number(process.env.CHAIN_ID) !== nodeId) {
    throw new Error(`CHAIN_ID=${process.env.CHAIN_ID} disagrees with the RPC node (chain ${nodeId})`);
  }
}

function loadConfig(): { cfg: IndexerConfig; rpcUrl: string; dbPath: string } {
  const chainId = Number(process.env.CHAIN_ID ?? QUALIFYING_CHAIN_ID);
  if (chainId !== QUALIFYING_CHAIN_ID) throw new Error(`Refusing chain ${chainId}: this indexer runs only on chain ${QUALIFYING_CHAIN_ID}`);
  // On the qualifying chain, only the qualifying router and the official USDT are accepted.
  const dep = (() => {
    try {
      return chainId === QUALIFYING_CHAIN_ID ? getQualifyingDeployment() : getDeployment(chainId);
    } catch {
      return undefined;
    }
  })();
  const deployBlock = Number(process.env.DEPLOY_BLOCK ?? dep?.deployBlock ?? NaN);
  if (!Number.isFinite(deployBlock)) throw new Error("No deploy block: set DEPLOY_BLOCK or record deployBlock in deployments.json");
  const usdt = process.env.USDT_ADDRESS ?? dep?.token ?? need("USDT_ADDRESS");
  assertQualifyingConfig({ chainId, tokenAddress: usdt });
  const router = process.env.ROUTER_ADDRESS ?? dep?.router ?? need("ROUTER_ADDRESS");
  assertQualifyingRouter(router);
  return {
    rpcUrl: need("RPC_URL"),
    dbPath: process.env.DATABASE_PATH ?? "./indexer.db",
    cfg: {
      router,
      usdt,
      facilitatorPayTo: process.env.FACILITATOR_PAYTO || undefined,
      confirmations: Number(process.env.CONFIRMATIONS ?? 12),
      deployBlock,
    },
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const [cmd, ...args] = process.argv.slice(2);
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  if (!cmd || cmd === "--help" || cmd === "-h") return console.log(USAGE);
  const { cfg, rpcUrl, dbPath } = loadConfig();
  // Commands that talk to the node must agree with it on the chain id; export and rebuild read only the local DB.
  if (cmd === "index" || cmd === "watch") await assertNodeChain(rpcUrl);
  const db = new IndexerDb(dbPath);
  const src = makeLogSource(rpcUrl);
  try {
    if (cmd === "index") {
      const r = await indexOnce({ db, src, cfg, log });
      log(`head ${r.head}, finalized ${r.finalized}, cursor now ${db.getCursor()?.block}, ledger rows ${db.ledger().length}`);
    } else if (cmd === "watch") {
      for (;;) {
        try {
          await indexOnce({ db, src, cfg, log });
        } catch (e) {
          log(`error: ${(e as Error).message}`);
          if (/reorg deeper/.test((e as Error).message)) throw e;
        }
        await new Promise((r) => setTimeout(r, Number(process.env.POLL_SECONDS ?? 5) * 1000));
      }
    } else if (cmd === "rebuild") {
      log(`rebuilt ${rebuild(db, cfg).length} ledger rows from raw events`);
    } else if (cmd === "export") {
      const out = flag(args, "out");
      if (!out) throw new Error("export needs --out FILE");
      const from = flag(args, "from");
      const to = flag(args, "to");
      const res = buildExport(db, cfg, {
        from: from ? Number(from) : undefined,
        to: to ? Number(to) : undefined,
        generatedAt: process.env.GENERATED_AT,
      });
      writeFilesAtomic([
        { path: out, data: res.csv },
        { path: `${out}.meta.json`, data: JSON.stringify(res.meta, null, 2) + "\n" },
      ]);
      log(`wrote ${res.rows.length} rows to ${out} (blocks ${res.meta.fromBlock}-${res.meta.toBlock}, finalized head ${db.getCursor()?.block})`);
    } else {
      console.log(USAGE);
      process.exitCode = 1;
    }
  } finally {
    if (cmd !== "watch") db.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
