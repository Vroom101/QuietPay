// Verifies the BUILT package (dist/) the way a customer would use it: ESM import, CommonJS require, a signed webhook
// round trip, and TypeScript types. Run after `pnpm build`:  node scripts/check-dist.mjs
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
};

for (const f of ["index.js", "index.cjs", "index.d.ts", "index.d.cts"]) check(`dist/${f} exists`, existsSync(join(dist, f)));

const WANT = ["createOrder", "getOrder", "listOrders", "refund", "getRefundContext", "getRefund", "listRefunds", "verifyWebhook", "paywall", "QuietpayApiError", "WebhookVerificationError", "WEBHOOK_SIGNATURE_HEADER"];
const esm = await import(pathToFileURL(join(dist, "index.js")).href);
const cjs = createRequire(import.meta.url)(join(dist, "index.cjs"));
for (const [label, m] of [["ESM", esm], ["CommonJS", cjs]]) {
  const missing = WANT.filter((k) => !(k in m));
  check(`${label} exports the public API`, missing.length === 0, missing.join(", "));
}

// The published bundle must not depend on the private workspace package at runtime.
const src = readFileSync(join(dist, "index.js"), "utf8") + readFileSync(join(dist, "index.cjs"), "utf8");
check("bundle does not import @quietpay/shared", !/from ["']@quietpay\/shared|require\(["']@quietpay\/shared/.test(src));
check("declarations do not reference @quietpay/shared or missing files", !/@quietpay\/shared|from '\.\//.test(readFileSync(join(dist, "index.d.ts"), "utf8")));

// Signed webhook round trip against the independent HMAC scheme (t=<ts>,v1=hmac_sha256(secret, `${ts}.${body}`)).
const secret = "check-dist-secret-0123456789abcdef";
const body = JSON.stringify({
  id: "evt_check_dist_1", type: "payment.settled", createdAt: Math.floor(Date.now() / 1000),
  data: { orderId: "0x" + "ab".repeat(32), merchantId: "0x" + "01".repeat(32), amount: "1000000", fee: "50000", payout: "0x" + "22".repeat(20) },
});
const ts = Math.floor(Date.now() / 1000);
const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
for (const [label, m] of [["ESM", esm], ["CommonJS", cjs]]) {
  let ok = false;
  try { ok = m.verifyWebhook({ secret, body, signatureHeader: `t=${ts},v1=${mac}` }).id === "evt_check_dist_1"; } catch (e) { ok = false; }
  check(`${label} verifyWebhook accepts a correctly signed body`, ok);
  let rejected = false;
  try { m.verifyWebhook({ secret, body: body + " ", signatureHeader: `t=${ts},v1=${mac}` }); } catch { rejected = true; }
  check(`${label} verifyWebhook rejects an altered body`, rejected);
  let emptyRejected = false;
  try { m.verifyWebhook({ secret: "", body, signatureHeader: `t=${ts},v1=${mac}` }); } catch { emptyRejected = true; }
  check(`${label} verifyWebhook refuses an empty secret`, emptyRejected);
}

// A TypeScript consumer compiles against the declarations (no workspace paths).
const tmp = mkdtempSync(join(tmpdir(), "qp-sdk-consumer-"));
writeFileSync(join(tmp, "consumer.ts"), `
import { createOrder, getOrder, refund, verifyWebhook, type Order, type WebhookEvent, QuietpayApiError } from ${JSON.stringify(pathToFileURL(join(dist, "index.js")).href.replace("file:///", ""))};
export async function demo(): Promise<string> {
  const o: Order = await createOrder({ baseUrl: "https://relayer.example", apiKey: "k", merchantId: ("0x" + "00".repeat(32)) as \`0x\${string}\`, amount: "1000000" });
  const same: Order = await getOrder({ baseUrl: "https://relayer.example", orderId: o.id });
  const ev: WebhookEvent = verifyWebhook({ secret: "s", body: "{}", signatureHeader: "t=1,v1=x" });
  void refund; void QuietpayApiError;
  return same.status + ev.type;
}
`);
writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, skipLibCheck: false, types: ["node"], typeRoots: [join(root, "node_modules", "@types")], baseUrl: ".", paths: { "*": [join(root, "node_modules", "*")] } }, files: ["consumer.ts"] }));
try {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", join(tmp, "tsconfig.json")], { stdio: "pipe" });
  check("a TypeScript consumer type-checks against dist/index.d.ts", true);
} catch (e) {
  check("a TypeScript consumer type-checks against dist/index.d.ts", false, String(e.stdout ?? e.message).split("\n").slice(0, 3).join(" | "));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll dist checks passed");
process.exit(failed ? 1 : 0);
