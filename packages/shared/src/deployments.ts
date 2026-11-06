import raw from "./deployments.json";
import { QUALIFYING_CHAIN_ID, QUALIFYING_USDT } from "./qualifying.js";

export interface MerchantRecord {
  merchantId: string;
  payout: string;
  refundSigner: string;
}

export interface Deployment {
  network: string;
  /** True only for a router that points at the official USDT on chain 1874. Older entries are history. */
  qualifying: boolean;
  router: string | null;
  token: string;
  /** Block the router was deployed in; indexers start here. */
  deployBlock?: number;
  deployTx: string | null;
  owner?: string;
  relayer?: string;
  merchants?: Record<string, MerchantRecord>;
  explorerUrl: string | null;
  deployTxUrl?: string;
  verified: boolean;
  note?: string;
  tokenKind?: string;
  tokenDeployTx?: string;
  tokenExplorerUrl?: string;
  demoMerchantSlug?: string;
  /** Superseded deployments, kept for the record. Never use these. */
  history?: Deployment[];
}

export const deployments = raw as unknown as Record<string, Deployment>;

export function getDeployment(chainId: number): Deployment {
  const d = deployments[String(chainId)];
  if (!d) throw new Error(`no deployment for chain ${chainId}`);
  return d;
}

/** The deployment every service must use. Throws unless it is the qualifying router for the official USDT. */
export function getQualifyingDeployment(): Deployment & { router: string; deployBlock: number } {
  const d = getDeployment(QUALIFYING_CHAIN_ID);
  if (!d.qualifying || !d.router || d.deployBlock === undefined) throw new Error("no qualifying deployment recorded yet");
  if (d.token.toLowerCase() !== QUALIFYING_USDT.toLowerCase()) throw new Error("deployment token is not the official USDT");
  return d as Deployment & { router: string; deployBlock: number };
}
