import { describe, expect, it } from "vitest";
import { verifyLedger } from "../src/index.js";
import { FakeChain, PAYTO, ROUTER, USDT, exportWithIndexer, scenario } from "./fake.js";

async function run(chain: FakeChain, src2: FakeChain) {
  const { csv, metaText } = await exportWithIndexer(chain);
  return verifyLedger({ csvText: csv, metaText, src: chain, src2, router: ROUTER, usdt: USDT, expectedPayTo: PAYTO, sleep: async () => undefined });
}
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe("T1c: --rpc2 cross-checks head, timestamps and settlement transfers", () => {
  it("passes when both nodes agree", async () => {
    expect((await run(scenario(), scenario())).issues).toEqual([]);
  });

  it("fails when the second node lies about a block timestamp", async () => {
    const liar = scenario();
    liar.getBlock = async (n: number) => ({ hash: "0x" + n.toString(16).padStart(64, "0"), timestamp: 1_800_000_000 + n * 2 + (n === 150 ? 3600 : 0) });
    const r = await run(scenario(), liar);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("rpc_disagreement");
  });

  it("fails when the second node omits a settlement Transfer log", async () => {
    const liar = scenario();
    // drop the USDT transfer to the relayer inside the first payment's tx, keep every router and pay-to log
    liar.logs = liar.logs.filter((l) => !(l.address === USDT && l.blockNumber === 150 && l.logIndex === 2));
    const r = await run(scenario(), liar);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("rpc_disagreement");
  });

  it("fails when the second node has not finalised the exported range", async () => {
    const behind = scenario(150); // head 150: nowhere near toBlock + confirmations
    const r = await run(scenario(), behind);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("rpc_disagreement");
  });
});
