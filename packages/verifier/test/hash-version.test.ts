import { describe, expect, it } from "vitest";
import { decodeRouterLog } from "@quietpay/indexer";
import { verifyLedger } from "../src/index.js";
import { decodeRouter } from "../src/spec.js";
import { PAYTO, ROUTER, USDT, exportWithIndexer, refundSignerChanged, scenario, tx } from "./fake.js";

const run = (csv: string, metaText: string, chain: ReturnType<typeof scenario>) =>
  verifyLedger({ csvText: csv, metaText, src: chain, router: ROUTER, usdt: USDT, expectedPayTo: PAYTO, sleep: async () => undefined });

describe("T1a: RefundSignerChanged is part of the event set (hashVersion 2)", () => {
  it("rotating the refund signer changes the event-set hash", async () => {
    const a = scenario();
    const b = scenario();
    b.add(refundSignerChanged(210, tx(0xb1)));
    const ea = await exportWithIndexer(a);
    const eb = await exportWithIndexer(b);
    expect(eb.meta.eventSetHash).not.toBe(ea.meta.eventSetHash);
    expect(eb.csv).toBe(ea.csv); // no row changes: only the hash notices the rotation
  });

  it("the indexer writes hashVersion 2 and the verifier accepts a rotation-bearing export", async () => {
    const chain = scenario();
    chain.add(refundSignerChanged(210, tx(0xb1)));
    const { csv, metaText, meta } = await exportWithIndexer(chain);
    expect(meta.hashVersion).toBe(2);
    const r = await run(csv, metaText, chain);
    expect(r.issues).toEqual([]);
  });

  it("a sidecar without hashVersion (version 1) is reported unsupported, not tampered", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain);
    const { hashVersion: _drop, ...old } = JSON.parse(metaText);
    const r = await run(csv, JSON.stringify(old), chain);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(["unsupported_hash_version"]);
    expect(r.issues[0]!.message).toMatch(/re-export/i);
  });

  it("an unknown future hashVersion is also unsupported", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain);
    const r = await run(csv, JSON.stringify({ ...JSON.parse(metaText), hashVersion: 3 }), chain);
    expect(r.issues.map((i) => i.code)).toEqual(["unsupported_hash_version"]);
  });

  it("both decoders produce identical output for the rotation log", () => {
    const l = refundSignerChanged(210, tx(0xb1));
    const a = decodeRouterLog(l);
    const b = decodeRouter(l);
    expect(a?.kind).toBe("RefundSignerChanged");
    expect(b?.kind).toBe("RefundSignerChanged");
    expect(b?.args).toEqual(a?.args);
  });
});
