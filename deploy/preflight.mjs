#!/usr/bin/env node
// Read-only deployment preflight. Usage: node deploy/preflight.mjs [--json]
// Reads the relayer environment (RPC_URL, ROUTER_ADDRESS, ...) plus PAYER_ADDRESS, REFUND_SIGNER_ADDRESS,
// MIN_RELAYER_WBT, PLANNED_PAYER_USDT, PLANNED_REFUND_SIGNER_USDT, PUBLIC_URL, WEBHOOK_URLS, RESOURCE_URLS,
// INSTANCE_COUNT (must be 1). Exit code 1 on any failed check. Never sends a transaction, never prints a secret.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relayer = resolve(root, "packages/relayer");
const tsx = createRequire(resolve(relayer, "package.json")).resolve("tsx/cli");
const r = spawnSync(process.execPath, [tsx, resolve(relayer, "src/preflight-cli.ts"), ...process.argv.slice(2).filter((a) => a === "--json")], { stdio: "inherit", cwd: relayer, env: process.env });
process.exit(r.status ?? 1);
