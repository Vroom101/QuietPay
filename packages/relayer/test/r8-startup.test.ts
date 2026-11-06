import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { assertNodeChainId } from "../src/chain.js";

function node(chainIdHex: string) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const s = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        const id = (JSON.parse(b) as { id: number }).id;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: chainIdHex }));
      });
    }).listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() }));
  });
}

describe("r8: node chain id check at startup", () => {
  it("accepts a node on the expected chain and refuses any other", async () => {
    const ok = await node("0x752"); // 1874
    const bad = await node("0x7a69"); // 31337
    try {
      await expect(assertNodeChainId(ok.url, 1874)).resolves.toBeUndefined();
      await expect(assertNodeChainId(bad.url, 1874)).rejects.toThrow(/chain id 31337, expected 1874/);
    } finally {
      ok.close();
      bad.close();
    }
  });
});
