import { isAddress, zeroAddress } from "viem";
import { getQualifyingDeployment } from "./deployments.js";
import { ConfigError, QUALIFYING_CHAIN_ID, QUALIFYING_USDT } from "./qualifying.js";

/** Most one call may send: 100 USDT in base units (6 decimals). */
export const FUND_CAP_BASE_UNITS = 100_000_000n;

export interface FundPlan {
  chainId: number | string | bigint;
  /** Token address, or "native" for a gas-token transfer (always refused). */
  token: string;
  to: string;
  amountBase: bigint;
  /** The recipient's current native (WBT) balance in wei. */
  payerWbt: bigint;
}

/**
 * Pre-flight for scripts/fund-payer.ts. Throws ConfigError unless the plan sends the official test USDT on
 * chain 1874, within the per-call cap, to a valid non-zero address that holds no WBT. The demo's point is a payer
 * that cannot pay gas, so this tool never sends WBT and refuses a payer that already has some.
 */
export function checkFundPlan(p: FundPlan): void {
  if (Number(p.chainId) !== QUALIFYING_CHAIN_ID) throw new ConfigError(`Wrong chain: expected ${QUALIFYING_CHAIN_ID}, got ${String(p.chainId)}`);
  if (p.token.toLowerCase() !== QUALIFYING_USDT.toLowerCase()) throw new ConfigError(`Wrong token: only the official USDT ${QUALIFYING_USDT} may be sent, got ${p.token}`);
  if (!isAddress(p.to, { strict: false }) || p.to.toLowerCase() === zeroAddress) throw new ConfigError(`Bad recipient: ${p.to}`);
  const dest = p.to.toLowerCase();
  if (dest === QUALIFYING_USDT.toLowerCase() || dest === getQualifyingDeployment().router.toLowerCase()) {
    throw new ConfigError("Bad recipient: the USDT contract and the router cannot be funded (tokens sent there are stuck for good)");
  }
  if (p.amountBase <= 0n) throw new ConfigError("Bad amount: must be positive");
  if (p.amountBase > FUND_CAP_BASE_UNITS) throw new ConfigError(`Amount above the per-call cap of ${FUND_CAP_BASE_UNITS} base units`);
  if (p.payerWbt > 0n) throw new ConfigError(`Recipient already holds ${p.payerWbt} wei of WBT; the demo payer must hold none`);
}
