// No-spend browser check of the merchant exports against the running stack (deploy/dev-stack.mjs):
//   1. the merchant signs in to the dashboard with their wallet
//   2. Analytics -> "Download ledger CSV + metadata" saves the on-chain ledger CSV and its metadata JSON
//   3. Transactions -> "Download CSV" with "Include gas fees (WBT)" saves a CSV with a gas_wbt column
//   4. the overview shows the relay-fee and network-gas cards
//   CHROME_PATH=<chrome.exe> node --env-file=<gitignored env> deploy/browser-ledger-check.mjs
// Needs MERCHANT_PAYOUT_PRIVATE_KEY (an allowed merchant wallet). Nothing from the env is printed.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(resolve(root, "apps/demo-store/package.json"))("@playwright/test");
const DASH = process.env.DASHBOARD_URL ?? "http://localhost:5174";
const key = process.env.MERCHANT_PAYOUT_PRIVATE_KEY;
if (!key) { console.error("missing MERCHANT_PAYOUT_PRIVATE_KEY"); process.exit(1); }
const merchant = privateKeyToAccount(key);

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`); if (!ok) failed += 1; };
const text = async (download) => readFileSync(await download.path(), "utf8");

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  await page.exposeFunction("__wallet", async (method, params) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [merchant.address.toLowerCase()];
    if (method === "eth_chainId") return "0x752";
    if (method === "personal_sign") return merchant.signMessage({ message: params[0] });
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
    throw new Error(`unsupported ${method}`);
  });
  await page.addInitScript(() => { window.ethereum = { isMetaMask: true, request: ({ method, params }) => window.__wallet(method, params ?? []) }; });
  await page.goto(DASH);
  await page.getByRole("button", { name: /Sign in with MetaMask/ }).click();
  await page.getByTestId("wallet-chip").waitFor({ timeout: 30_000 });
  check("merchant signed in with the wallet", true);

  const cards = (await page.locator(".md-metric").allTextContents()).join(" | ");
  check("overview shows the relay fees card", /Relay fees paid/.test(cards));
  check("overview shows the network gas card in WBT", /Network gas covered\s*[\d.]+\s*WBT/.test(cards), cards.match(/Network gas covered[^|]*/)?.[0]?.slice(0, 120));

  await page.getByRole("button", { name: "Analytics", exact: true }).click();
  const button = page.getByTestId("ledger-download");
  await button.waitFor({ timeout: 20_000 });
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await button.click();
  await page.getByRole("status").filter({ hasText: /Downloaded \d+ ledger rows/ }).waitFor({ timeout: 60_000 }).catch(() => {});
  for (let i = 0; i < 50 && downloads.length < 2; i++) await page.waitForTimeout(200);
  const csv = downloads.find((d) => d.suggestedFilename().endsWith(".csv"));
  const meta = downloads.find((d) => d.suggestedFilename().endsWith(".meta.json"));
  check("ledger CSV downloaded", !!csv, csv?.suggestedFilename());
  check("ledger metadata JSON downloaded", !!meta, meta?.suggestedFilename());
  if (csv && meta) {
    const body = await text(csv);
    const m = JSON.parse(await text(meta));
    check("ledger CSV has the event-journal header and on-chain rows", body.startsWith("date_utc,source,order_id") && body.trim().split("\n").length > 1, `${body.trim().split("\n").length - 1} rows`);
    check("metadata pins chain 1874, the qualifying router and the official USDT", m.chainId === 1874 && m.router === "0xb9d475cdd817900b45c356169c6fdc379b942d82" && m.token === "0xcedfb56113143d55b2358b8cfbb0deb5ad2f55a7");
  }
  const alert = await page.getByRole("alert").allTextContents();
  check("no error shown on the ledger panel", !alert.some((t) => /ledger/i.test(t)), alert.join(" ").slice(0, 120));

  await page.getByRole("button", { name: "Transactions", exact: true }).click();
  await page.getByTestId("transactions-csv").waitFor({ timeout: 20_000 });
  const gasBox = page.getByTestId("include-gas");
  check("'Include gas fees (WBT)' option is available and on", (await gasBox.isEnabled()) && (await gasBox.isChecked()));
  const [tx] = await Promise.all([page.waitForEvent("download"), page.getByTestId("transactions-csv").click()]);
  const txCsv = await text(tx);
  const header = txCsv.split("\n")[0];
  check("transactions CSV includes gas_wbt", header.endsWith(",gas_wbt"), header);
  await gasBox.uncheck();
  const [tx2] = await Promise.all([page.waitForEvent("download"), page.getByTestId("transactions-csv").click()]);
  check("unticking the option drops the gas column", !(await text(tx2)).split("\n")[0].includes("gas_wbt"));
  await ctx.close();
} catch (e) {
  check("run completed without an unexpected error", false, String(e.message).slice(0, 200));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll ledger/export browser checks passed");
process.exit(failed ? 1 : 0);
