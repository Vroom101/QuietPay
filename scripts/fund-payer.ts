/**
 * Sends official test USDT (never WBT) from a funder wallet to the demo payer.
 *   FUNDER_PRIVATE_KEY=0x.. RPC_URL=https://.. pnpm exec tsx scripts/fund-payer.ts <payer> <amount-in-USDT> [--dry-run]
 * Refuses: any chain but 1874, any token but the official USDT, amounts above the per-call cap, and a payer that
 * already holds WBT. The key is read from the environment and never printed.
 */
import { createPublicClient, createWalletClient, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QUALIFYING_USDT, checkFundPlan, parseUsdt } from "../packages/shared/src/index.js";

const abi = parseAbi(["function transfer(address to, uint256 value) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

async function main() {
  const [to, amount, ...flags] = process.argv.slice(2);
  if (!to || !amount) throw new Error("usage: fund-payer.ts <payer address> <amount in USDT> [--dry-run]");
  const rpc = process.env.RPC_URL;
  const pk = process.env.FUNDER_PRIVATE_KEY;
  if (!rpc || !pk) throw new Error("RPC_URL and FUNDER_PRIVATE_KEY must be set in the environment");
  const account = privateKeyToAccount(pk as `0x${string}`);
  const pub = createPublicClient({ transport: http(rpc) });
  const chainId = await pub.getChainId();
  const payerWbt = await pub.getBalance({ address: getAddress(to) });
  const amountBase = parseUsdt(amount);
  checkFundPlan({ chainId, token: QUALIFYING_USDT, to, amountBase, payerWbt });
  const bal = (await pub.readContract({ address: QUALIFYING_USDT, abi, functionName: "balanceOf", args: [account.address] })) as bigint;
  if (bal < amountBase) throw new Error(`funder ${account.address} holds ${bal} base units of USDT, needs ${amountBase}`);
  console.log(`plan: send ${amount} USDT (official ${QUALIFYING_USDT}) from ${account.address} to ${getAddress(to)} on chain ${chainId}`);
  if (flags.includes("--dry-run")) return console.log("dry run: nothing sent");
  const wallet = createWalletClient({ account, transport: http(rpc) });
  const hash = await wallet.writeContract({ address: QUALIFYING_USDT, abi, functionName: "transfer", args: [getAddress(to), amountBase], chain: null });
  console.log(`sent: https://explorer.testnet.whitechain.io/tx/${hash}`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
