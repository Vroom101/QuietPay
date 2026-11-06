import { createHmac } from "node:crypto";

/** Per-merchant webhook secret, derived exactly as documented in packages/relayer/src/webhooks.ts. */
export function merchantWebhookSecretFor(masterSecret: string, merchantId: string): string {
  return createHmac("sha256", masterSecret).update(merchantId.toLowerCase()).digest("hex");
}
