import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeLogSource } from "@quietpay/indexer";
import { makeVerifierSource } from "../src/source.js";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const log = (idx: number, removed: boolean) => ({
  address: "0xAbC0000000000000000000000000000000000001", blockNumber: "0x64", blockHash: word(100), transactionHash: word(idx + 1),
  logIndex: "0x" + idx.toString(16), topics: [word(1)], data: "0x", removed,
});

let server: ReturnType<typeof createServer>;
let url = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      const result = method === "eth_getLogs" ? [log(0, false), log(1, true), log(2, false)] : method === "eth_chainId" ? "0x752" : "0x1";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("logs flagged removed (reorged out) are never counted", () => {
  const q = { address: "0xabc0000000000000000000000000000000000001", fromBlock: 100, toBlock: 100 };
  it("the verifier's own source drops them and lowercases fields", async () => {
    const got = await makeVerifierSource(url).getLogs(q);
    expect(got.map((l) => l.logIndex)).toEqual([0, 2]);
    expect(got[0]!.address).toBe(got[0]!.address.toLowerCase());
  });
  it("the indexer's source drops them too", async () => {
    const got = await makeLogSource(url).getLogs(q);
    expect(got.map((l) => l.logIndex)).toEqual([0, 2]);
  });
  it("reports the chain id", async () => {
    expect(await makeVerifierSource(url).getChainId()).toBe(1874);
  });
});
