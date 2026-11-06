import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Runs the real entry file with an empty environment: it must refuse to start and say which settings are missing. */
function run(env: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>((res) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill(), 110_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      res({ code, output });
    });
  });
}

describe("facilitator entry file (src/main.ts)", () => {
  it("exits non-zero and names the missing settings when the environment is empty", async () => {
    const { code, output } = await run({});
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(output).toMatch(/OPERATOR_TOKEN|MERCHANT_API_KEYS|WEBHOOK_SECRET/);
  }, 130_000);

  it("rejects a too-short OPERATOR_TOKEN with a clear message and never starts listening", async () => {
    const { output } = await run({ OPERATOR_TOKEN: "short" });
    expect(output).not.toMatch(/listening/);
    expect(output).toMatch(/OPERATOR_TOKEN must be at least 16 characters/);
  }, 130_000);
});
