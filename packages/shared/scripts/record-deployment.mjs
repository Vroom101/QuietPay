// Writes contracts/deployments.json from a forge broadcast file and the chain, then mirrors it into packages/shared.
// Usage (local shell): RPC_URL=... OWNER_ADDRESS=0x.. RELAYER_ADDRESS=0x.. MERCHANT_PAYOUT=0x.. REFUND_SIGNER=0x.. \
//   node scripts/record-deployment.mjs [path/to/run-latest.json]
// Older entries are kept under "history" with "qualifying": false. Never edit deployments.json by hand.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http, keccak256, stringToHex } from "viem";
import { paymentRouterAbi } from "@quietpay/shared";

const here = dirname(fileURLToPath(import.meta.url));
// DEPLOYMENTS_ROOT is a test hook: it redirects the files this script reads and writes.
const root = process.env.DEPLOYMENTS_ROOT ? resolve(process.env.DEPLOYMENTS_ROOT) : resolve(here, "../../..");
const e = process.env;
for (const k of ["RPC_URL", "OWNER_ADDRESS", "RELAYER_ADDRESS", "MERCHANT_PAYOUT", "REFUND_SIGNER"]) if (!e[k]) throw new Error(`Set ${k}`);
const USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7";
const file = process.argv[2] ?? resolve(root, "contracts/broadcast/DeployQualifying.s.sol/1874/run-latest.json");
const run = JSON.parse(readFileSync(file, "utf8"));
// forge's `transactions[].hash` can be mismatched; the receipt that carries `contractAddress` is the creation tx.
const rc = (run.receipts ?? []).find((r) => r.contractAddress);
if (!rc) throw new Error("no creation receipt (with contractAddress) in the broadcast file");
const create = { hash: rc.transactionHash, contractAddress: getAddress(rc.contractAddress) };

const pub = createPublicClient({ transport: http(e.RPC_URL) });
const chainId = await pub.getChainId();
if (chainId !== 1874) throw new Error(`RPC is chain ${chainId}, expected 1874`);
const receipt = await pub.getTransactionReceipt({ hash: create.hash });
if (receipt.status !== "success" || receipt.contractAddress?.toLowerCase() !== create.contractAddress.toLowerCase()) throw new Error("deploy receipt mismatch");
const code = await pub.getCode({ address: create.contractAddress });
if (!code || code === "0x") throw new Error("no code at the router address");

// Read the router back from chain: never record owner/relayer/payout/refundSigner/token that the chain does not confirm.
{
  const router = create.contractAddress;
  const read = (functionName, args = []) => pub.readContract({ address: router, abi: paymentRouterAbi, functionName, args });
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const problems = [];
  const tok = await read("token");
  if (!same(tok, USDT)) problems.push(`token() is ${tok}, not the official USDT ${USDT}`);
  const own = await read("owner");
  if (!same(own, getAddress(e.OWNER_ADDRESS))) problems.push(`owner() is ${own}, env OWNER_ADDRESS is ${e.OWNER_ADDRESS}`);
  if ((await read("isRelayer", [getAddress(e.RELAYER_ADDRESS)])) !== true) problems.push(`${e.RELAYER_ADDRESS} is not an allowlisted relayer on chain`);
  const [payout, refundSigner] = await read("merchants", [keccak256(stringToHex(e.MERCHANT_SLUG ?? "demo-store"))]);
  if (!same(payout, getAddress(e.MERCHANT_PAYOUT))) problems.push(`merchant payout on chain is ${payout}, env MERCHANT_PAYOUT is ${e.MERCHANT_PAYOUT}`);
  if (!same(refundSigner, getAddress(e.REFUND_SIGNER))) problems.push(`merchant refundSigner on chain is ${refundSigner}, env REFUND_SIGNER is ${e.REFUND_SIGNER}`);
  if (problems.length) throw new Error(`Refusing to record: ${problems.join("; ")}`);
}

const path = resolve(root, "contracts/deployments.json");
const old = JSON.parse(readFileSync(path, "utf8"))["1874"];
const history = [...(old?.history ?? [])];
if (old && old.router && old.router.toLowerCase() !== create.contractAddress.toLowerCase()) {
  const { history: _h, ...prev } = old;
  history.push({ ...prev, qualifying: false, note: prev.note ?? "superseded" });
}
const slug = e.MERCHANT_SLUG ?? "demo-store";
const explorer = (e.EXPLORER_BASE_URL ?? "https://explorer.testnet.whitechain.io").replace(/\/$/, "");
const entry = {
  network: "Whitechain Sepolia",
  qualifying: true,
  router: create.contractAddress,
  token: USDT,
  deployBlock: Number(receipt.blockNumber),
  deployTx: create.hash,
  owner: getAddress(e.OWNER_ADDRESS),
  relayer: getAddress(e.RELAYER_ADDRESS),
  merchants: { [slug]: { merchantId: keccak256(stringToHex(slug)), payout: getAddress(e.MERCHANT_PAYOUT), refundSigner: getAddress(e.REFUND_SIGNER) } },
  explorerUrl: `${explorer}/address/${create.contractAddress}`,
  deployTxUrl: `${explorer}/tx/${create.hash}`,
  verified: e.VERIFIED === "false" ? false : true,
  history,
};
writeFileSync(path, JSON.stringify({ 1874: entry }, null, 2) + "\n");
writeFileSync(resolve(root, "packages/shared/src/deployments.json"), JSON.stringify({ 1874: entry }, null, 2) + "\n");
console.log("recorded", entry.router, "block", entry.deployBlock);
