// REAL subscription run in a browser against the stack from deploy/dev-stack.mjs (Whitechain Sepolia, official USDT).
// It spends 1 test USDT (the first period of a 1 USDT/month plan), gaslessly:
//   1. the merchant signs in to the dashboard with their wallet and creates a 1 USDT / month plan (Billing view)
//   2. a customer opens the plan's signup link, consents, and pays the first period from their wallet
//   3. the customer's subscription page shows Active with 1 period paid and a next payment date
//   4. the dashboard lists the subscriber and shows 1.00 USDT monthly recurring revenue
//   CHROME_PATH=<chrome.exe> node --env-file=<gitignored env> deploy/browser-subscription-real.mjs
// Needs PAYER_PRIVATE_KEY, MERCHANT_PAYOUT_PRIVATE_KEY and RPC_URL. Nothing from the env is printed.
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(resolve(root, "apps/demo-store/package.json"))("@playwright/test");
const DASH = process.env.DASHBOARD_URL ?? "http://localhost:5174";
const STORE = process.env.STORE_URL ?? "http://localhost:5173";
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(1); } return v; };
const rpcUrl = need("RPC_URL");
const payer = privateKeyToAccount(need("PAYER_PRIVATE_KEY"));
const merchant = privateKeyToAccount(need("MERCHANT_PAYOUT_PRIVATE_KEY"));

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`); if (!ok) failed += 1; };
const rpc = async (method, params) => {
  const j = await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const wbt = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));
const nonce = async (a) => BigInt(await rpc("eth_getTransactionCount", [a, "latest"]));

async function tab(browser, acct) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.exposeFunction("__wallet", async (method, params) => {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return [acct.address.toLowerCase()];
      case "eth_chainId": return "0x752";
      case "wallet_switchEthereumChain": case "wallet_addEthereumChain": return null;
      case "eth_call": return rpc("eth_call", params);
      case "personal_sign": return acct.signMessage({ message: params[0] });
      case "eth_signTypedData_v4": {
        const t = JSON.parse(params[1]);
        const { EIP712Domain: _d, ...types } = t.types;
        return acct.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: t.message });
      }
      default: throw new Error(`unsupported ${method}`);
    }
  });
  await page.addInitScript(() => { window.ethereum = { isMetaMask: true, request: ({ method, params }) => window.__wallet(method, params ?? []) }; });
  return { page, ctx };
}

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const before = { wbt: await wbt(payer.address), nonce: await nonce(payer.address) };

  // 1. merchant creates a plan
  const mer = await tab(browser, merchant);
  await mer.page.goto(DASH);
  await mer.page.getByRole("button", { name: /Sign in with MetaMask/ }).click();
  await mer.page.getByTestId("wallet-chip").waitFor({ timeout: 30_000 });
  await mer.page.getByRole("button", { name: "Billing", exact: true }).click();
  const planForm = mer.page.getByRole("form", { name: "Create plan" });
  const planName = `Live plan ${new Date().toISOString().slice(11, 19)}`;
  const links = () => mer.page.getByLabel("Signup link").evaluateAll((els) => els.map((e) => e.value));
  await planForm.getByRole("button", { name: "Create plan" }).waitFor({ timeout: 20_000 });
  await mer.page.waitForTimeout(1500); // let the existing plans load
  const known = new Set(await links());
  await planForm.getByLabel("Plan name").fill(planName);
  await planForm.getByLabel("Amount (USDT)").fill("1.00");
  await planForm.getByLabel("Interval").selectOption("month");
  await planForm.getByRole("button", { name: "Create plan" }).click();
  let url;
  for (let i = 0; i < 40 && !url; i++) { url = (await links()).find((v) => /\/subscribe\//.test(v) && !known.has(v)); if (!url) await mer.page.waitForTimeout(500); }
  check("merchant created a 1 USDT / month plan and got a signup link", !!url, url);

  // 2. customer subscribes and pays the first period
  const cust = await tab(browser, payer);
  await cust.page.goto(url.replace(/^https?:\/\/[^/]+/, STORE));
  await cust.page.getByRole("heading", { name: planName }).waitFor({ timeout: 20_000 });
  check("customer sees the plan", true);
  await cust.page.getByRole("checkbox").check();
  await cust.page.getByRole("button", { name: "Subscribe and pay first period" }).click();
  await cust.page.getByTestId("pay-wallet").click({ timeout: 30_000 });
  await cust.page.waitForURL(/\/subscription\//, { timeout: 150_000 });
  check("first period paid from the wallet; landed on the subscription page", true);

  // 3. subscription page shows it (the page itself waits for the confirmation webhook; no reload)
  const body = async () => ((await cust.page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
  const offeredPayBeforeConfirm = /Pay [\d.]+ USDT now/.test(await body()) && /Periods paid ?0/.test(await body());
  check("right after paying, the page does not ask to pay the same period again", !offeredPayBeforeConfirm);
  await cust.page.getByText(/Periods paid\s*1/).waitFor({ timeout: 40_000 }).catch(() => {});
  const page = await body();
  check("subscription is Active with 1 period paid and a next payment date", /Status ?Active/.test(page) && /Periods paid ?1/.test(page) && /Next payment/.test(page), page.match(/Status.{0,140}/)?.[0]);
  check("no 'Pay now' offered for the period already paid", !/Pay [\d.]+ USDT now/.test(page));
  const after = { wbt: await wbt(payer.address), nonce: await nonce(payer.address) };
  check("subscriber paid no gas (WBT and nonce unchanged)", after.wbt === before.wbt && after.nonce === before.nonce);

  // 4. dashboard lists the subscriber
  await mer.page.reload();
  await mer.page.getByRole("button", { name: "Billing", exact: true }).click();
  await mer.page.getByTestId("subs-active").waitFor({ timeout: 20_000 });
  await mer.page.getByText("Loading subscriptions").waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});
  const active = Number(await mer.page.getByTestId("subs-active").textContent());
  const mrr = await mer.page.getByTestId("subs-mrr").textContent();
  check("dashboard counts the active subscriber and shows MRR", active >= 1 && /^\s*[1-9]/.test(mrr ?? ""), `active ${active}, MRR ${mrr}`);
  await cust.ctx.close(); await mer.ctx.close();
} catch (e) {
  check("run completed without an unexpected error", false, String(e.message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 240));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll real subscription checks passed");
process.exit(failed ? 1 : 0);
