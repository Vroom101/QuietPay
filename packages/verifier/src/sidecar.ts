import type { ExportMeta } from "@quietpay/indexer";

const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Parses and checks the `.meta.json` sidecar. Returns the reason on failure. */
export function parseSidecar(text: string): { meta: ExportMeta } | { error: string } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return { error: `sidecar is not valid JSON (${(e as Error).message})` };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { error: "sidecar must be a JSON object" };
  if (!isUint(j.fromBlock)) return { error: "sidecar fromBlock must be a non-negative integer" };
  if (!isUint(j.toBlock)) return { error: "sidecar toBlock must be a non-negative integer" };
  if (j.toBlock < j.fromBlock) return { error: `sidecar toBlock ${j.toBlock} is before fromBlock ${j.fromBlock}` };
  if (!isUint(j.confirmations)) return { error: "sidecar confirmations must be a non-negative integer" };
  if (typeof j.eventSetHash !== "string" || !/^[0-9a-f]{64}$/.test(j.eventSetHash)) return { error: "sidecar eventSetHash must be 64 lowercase hex chars" };
  return {
    meta: {
      fromBlock: j.fromBlock,
      toBlock: j.toBlock,
      confirmations: j.confirmations,
      eventSetHash: j.eventSetHash,
      generatedAt: typeof j.generatedAt === "string" ? j.generatedAt : "",
    },
  };
}
