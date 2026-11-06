import raw from "./deployments.json";

export interface Deployment {
  network: string;
  router: string | null;
  token: string;
  deployTx: string | null;
  explorerUrl: string | null;
  verified: boolean;
  /** Block the router was deployed in; indexers start here. */
  deployBlock?: number;
  tokenKind?: string;
  tokenDeployTx?: string;
  tokenExplorerUrl?: string;
  demoMerchantSlug?: string;
}

export const deployments = raw as Record<string, Deployment>;

export function getDeployment(chainId: number): Deployment {
  const d = deployments[String(chainId)];
  if (!d) throw new Error(`no deployment for chain ${chainId}`);
  return d;
}
