import { startLocalStack } from "./stack.js";
import { payOrder } from "./actions.js";
const s = await startLocalStack();
try {
  const p = await s.newPayer();
  const r = await payOrder(s, 10_000_000n, p.key);
  console.log(r.settled.status, r.txHash, await s.wbtOf(p.address), await s.usdtOf(s.tenant.payout));
  await new Promise((r) => setTimeout(r, 6000));
  console.log(s.sink.hits.length);
} finally { await s.stop(); }
process.exit(0);
