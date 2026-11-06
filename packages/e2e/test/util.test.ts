import { afterEach, describe, expect, it } from "vitest";
import { addSecret, explorerTx, redact, waitUntil } from "../src/util.js";

const KEY = "0x" + "ab".repeat(32);
const RPC = "https://rpc.example.test/v2/SECRETAPIKEY123456?token=querysecret99";
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string) => {
  saved[k] = process.env[k];
  process.env[k] = v;
};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("e2e output is scrubbed of secrets (the live runner prints a lot)", () => {
  it("hides a private key with and without the 0x prefix", () => {
    setEnv("PAYER_PRIVATE_KEY", KEY);
    expect(redact(`key ${KEY} and raw ${KEY.slice(2)}`)).toBe("key [redacted] and raw [redacted]");
  });

  it("hides the RPC URL, its host, its path key and its query secret", () => {
    setEnv("RPC_URL", RPC);
    const out = redact(`failed GET ${RPC} on rpc.example.test at /v2/SECRETAPIKEY123456 token querysecret99`);
    for (const piece of ["SECRETAPIKEY123456", "querysecret99", "rpc.example.test"]) expect(out).not.toContain(piece);
  });

  it("hides secrets registered at run time (derived webhook secrets, generated API keys)", () => {
    addSecret("derived-webhook-secret-xyz");
    expect(redact("sig=derived-webhook-secret-xyz")).toBe("sig=[redacted]");
  });

  it("ignores very short values so ordinary text is not mangled, and leaves plain text alone", () => {
    setEnv("OPERATOR_TOKEN", "abc");
    addSecret("xy");
    expect(redact("abc xy and an ordinary sentence")).toBe("abc xy and an ordinary sentence");
  });

  it("does not leave a partially redacted longer secret behind (longest match first)", () => {
    setEnv("WEBHOOK_SECRET", "shortsecret");
    addSecret("shortsecret-and-more");
    expect(redact("v=shortsecret-and-more")).toBe("v=[redacted]");
  });
});

describe("e2e helpers", () => {
  it("explorerTx links to the Whitechain testnet explorer", () => {
    expect(explorerTx("0x" + "12".repeat(32))).toBe("https://explorer.testnet.whitechain.io/tx/0x" + "12".repeat(32));
  });

  it("waitUntil returns the first truthy value and times out with the condition's name", async () => {
    let n = 0;
    await expect(waitUntil(() => (++n >= 3 ? "done" : undefined), "three tries", 2000, 5)).resolves.toBe("done");
    await expect(waitUntil(() => false, "never", 60, 10)).rejects.toThrow("timed out waiting for never");
  });
});
