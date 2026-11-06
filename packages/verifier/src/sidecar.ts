export interface ExportMeta {
  fromBlock: number;
  toBlock: number;
  confirmations: number;
  eventSetHash: string;
  router: string;
  usdt: string;
  payTo: string | null;
  generatedAt: string;
}

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
  // The pins are REQUIRED: the sidecar comes from whoever hands over the files, so a missing key must never switch the
  // corresponding check off. The exporter always writes all three (payTo is a string or null).
  const addr = /^0x[0-9a-fA-F]{40}$/;
  for (const k of ["router", "usdt"] as const) {
    if (typeof j[k] !== "string" || !addr.test(j[k] as string)) return { error: `malformed_sidecar: sidecar ${k} is missing or not an address; the pins are required and a stripped sidecar cannot be verified` };
  }
  if (!("payTo" in j) || !(j.payTo === null || (typeof j.payTo === "string" && addr.test(j.payTo)))) {
    return { error: "malformed_sidecar: sidecar payTo is missing (it must be an address or null); the pins are required and a stripped sidecar cannot be verified" };
  }
  return {
    meta: {
      fromBlock: j.fromBlock,
      toBlock: j.toBlock,
      confirmations: j.confirmations,
      eventSetHash: j.eventSetHash,
      router: (j.router as string).toLowerCase(),
      usdt: (j.usdt as string).toLowerCase(),
      payTo: j.payTo === null ? null : (j.payTo as string).toLowerCase(),
      generatedAt: typeof j.generatedAt === "string" ? j.generatedAt : "",
    },
  };
}
