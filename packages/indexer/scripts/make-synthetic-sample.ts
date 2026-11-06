// Builds docs/lead/samples/synthetic-sample.csv from hand-made logs (NOT live chain data) so the verifier page has a
// format sample before a real payment exists. Run: pnpm --filter @quietpay/indexer exec tsx scripts/make-synthetic-sample.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { IndexerDb, buildExport, indexOnce } from "../src/index.js";
import { FakeChain, PAYER, PAYTO, ROUTER, cfg, order, paidLog, refundedLog, transferLog, txHash } from "../test/fake.js";

const chain = new FakeChain(400);
const tx = txHash(0xabc);
chain.add(
  paidLog({ block: 150, orderId: order(1), value: 25_000_000n, fee: 50_000n }),
  refundedLog({ block: 160, orderId: order(1), amount: 5_000_000n, total: 5_000_000n, index: 0 }),
  paidLog({ block: 170, orderId: order(2), value: 1_000_000n, fee: 20_000n }),
  transferLog({ block: 175, from: PAYER, to: PAYTO, value: 1_500_000n }),
  // a router payout to the facilitator address: excluded by the double-count rule (counted once, as router)
  transferLog({ block: 180, tx, logIndex: 1, from: ROUTER, to: PAYTO, value: 9_950_000n }),
  paidLog({ block: 180, tx, logIndex: 3, orderId: order(3), value: 10_000_000n, fee: 50_000n, payout: PAYTO }),
);
const db = new IndexerDb(":memory:");
const config = cfg();
await indexOnce({ db, src: chain, cfg: config });
const res = buildExport(db, config, { from: 100, to: 300, generatedAt: "2026-01-01T00:00:00.000Z" });
const dir = resolve(import.meta.dirname, "../../../docs/lead/samples");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "synthetic-sample.csv"), res.csv);
writeFileSync(resolve(dir, "synthetic-sample.csv.meta.json"), JSON.stringify(res.meta, null, 2) + "\n");
console.log(`wrote ${res.rows.length} synthetic rows`);
