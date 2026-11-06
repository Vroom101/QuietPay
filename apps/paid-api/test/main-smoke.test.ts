import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => res(port));
    });
  });

const goodEnv = (port: number): Record<string, string> => ({
  PAID_API_PUBLIC_URL: `http://127.0.0.1:${port}`,
  FACILITATOR_URL: "http://127.0.0.1:1",
  QUIETPAY_API_KEY: "smoke-test-key",
  FACILITATOR_MERCHANT_ID: "0x" + "01".repeat(32),
  FACILITATOR_PAYTO: "0x" + "22".repeat(20),
  PAID_API_PORT: String(port),
});

/** Boots the real entry file in a child process with only the given env (no inherited secrets). */
function boot(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((res) => child.once("exit", (c) => res(c)));
  return { child, exited, output: () => out };
}

describe("paid-api entry file (main.ts)", () => {
  it("fails fast, naming the variable, when a required env var is missing", async () => {
    for (const key of ["PAID_API_PUBLIC_URL", "FACILITATOR_URL", "QUIETPAY_API_KEY", "FACILITATOR_MERCHANT_ID", "FACILITATOR_PAYTO"]) {
      const env = goodEnv(await freePort());
      delete env[key];
      const p = boot(env);
      const code = await p.exited;
      expect(code, `missing ${key} must exit non-zero`).not.toBe(0);
      expect(p.output()).toContain(key);
    }
  }, 130_000);

  it("boots with a fake env, serves /health and a 402 challenge, then stops when killed", async () => {
    const port = await freePort();
    const p = boot(goodEnv(port));
    try {
      let ok = false;
      for (let i = 0; i < 150 && !ok; i++) {
        try {
          ok = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(ok, `server did not come up; output: ${p.output()}`).toBe(true);
      const paid = await fetch(`http://127.0.0.1:${port}/v1/quote`);
      expect(paid.status).toBe(402);
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 130_000);
});
