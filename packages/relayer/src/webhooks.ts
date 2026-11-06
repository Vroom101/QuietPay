import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from "@quietpay/shared/webhook";
import { pinnedPost, resolveDeliveryTarget } from "./webhook-pin.js";
import { DELIVERY_BACKOFF_SECONDS, MAX_DELIVERY_ATTEMPTS, type Db, type DeliveryRow } from "./db.js";

// ------------------------------------------------------------------ per-merchant secrets

/**
 * Per-merchant webhook signing secret.
 *
 *   secret = lowercase hex( HMAC-SHA256(key = WEBHOOK_SECRET, message = merchantId.toLowerCase()) )
 *
 * `merchantId` is the 0x-prefixed bytes32 string, lowercased, as UTF-8. WEBHOOK_SECRET stays the
 * operator's master key and is never sent to anyone. Each merchant is given only its derived secret
 * (no API route exposes it), so a merchant cannot forge webhooks for another merchant. Operators derive
 * it with e.g.:
 *
 *   printf %s 0x<merchantId lowercase> | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET"
 */
export function merchantWebhookSecret(masterSecret: string, merchantId: string): string {
  return createHmac("sha256", masterSecret).update(merchantId.toLowerCase()).digest("hex");
}

// ------------------------------------------------------------------ SSRF policy

type IpClass = "public" | "private" | "forbidden";

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, p) => a * 256 + Number(p), 0);
}

function inV4(n: number, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  const b = v4ToInt(base);
  return n >= b && n < b + size;
}

function classifyV4(ip: string): IpClass {
  const n = v4ToInt(ip);
  // Never allowed, even with ALLOW_PRIVATE_WEBHOOKS: "this host", link-local / cloud metadata,
  // multicast, reserved and broadcast.
  if (inV4(n, "0.0.0.0", 8) || inV4(n, "169.254.0.0", 16) || inV4(n, "224.0.0.0", 4) || inV4(n, "240.0.0.0", 4)) {
    return "forbidden";
  }
  if (
    inV4(n, "127.0.0.0", 8) ||
    inV4(n, "10.0.0.0", 8) ||
    inV4(n, "172.16.0.0", 12) ||
    inV4(n, "192.168.0.0", 16) ||
    inV4(n, "100.64.0.0", 10) ||
    inV4(n, "198.18.0.0", 15) ||
    inV4(n, "192.0.0.0", 24)
  ) {
    return "private";
  }
  return "public";
}

/** Expands an IPv6 literal (already validated by isIP) into 8 16-bit groups. */
function expandV6(ip: string): number[] {
  let s = ip.split("%")[0]!;
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[2]!.split(".").map(Number);
    s = `${dotted[1]}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - (tail ? tail.split(":").length : 0)).fill("0"), ...(tail ? tail.split(":") : [])];
  return groups.map((g) => parseInt(g, 16));
}

function classifyV6(ip: string): IpClass {
  const g = expandV6(ip);
  const embeddedV4 = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // Transition / translation ranges that tunnel to or translate into IPv4 (possibly internal) targets.
  // No legitimate webhook endpoint uses them, so they are refused outright, even with allowPrivate:
  //   IPv4-translated ::ffff:0:a.b.c.d, 6to4 2002::/16, Teredo 2001::/32, NAT64 local-use 64:ff9b:1::/48.
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return "forbidden";
  if (g[0] === 0x2002) return "forbidden";
  if (g[0] === 0x2001 && g[1] === 0) return "forbidden";
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return "forbidden";
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the embedded IPv4.
  if (zeros(5) && g[5] === 0xffff) return classifyV4(embeddedV4());
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyV4(embeddedV4());
  if (zeros(8)) return "forbidden"; // ::
  if (zeros(7) && g[7] === 1) return "private"; // ::1
  if (zeros(6) && (g[6] !== 0 || g[7]! > 1)) return classifyV4(embeddedV4());
  if ((g[0]! & 0xffc0) === 0xfe80) return "forbidden"; // link-local fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return "forbidden"; // multicast
  if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfec0) return "private"; // deprecated site-local
  return "public";
}

export function classifyIp(ip: string): IpClass {
  const v = isIP(ip);
  if (v === 4) return classifyV4(ip);
  if (v === 6) return classifyV6(ip);
  return "forbidden";
}

const ALWAYS_FORBIDDEN_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "metadata"]);
const CANONICAL_V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const NUMERIC_HOST = /^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*\.?$/i;

/**
 * Static checks on a merchant-supplied webhook URL. Returns a reason if it must be refused, else null.
 * `allowPrivate` (ALLOW_PRIVATE_WEBHOOKS=1, for local dev and tests) permits loopback and private
 * ranges; link-local, cloud metadata and 0.0.0.0 are refused regardless.
 */
export function webhookUrlProblem(raw: string, allowPrivate: boolean): string | null {
  if (/[\u0000-\u001f\u007f\s\\]/.test(raw)) return "webhookUrl must not contain whitespace, control characters or backslashes";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "webhookUrl is not a valid URL";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "webhookUrl must use http or https";
  if (u.username || u.password) return "webhookUrl must not contain credentials";
  // The URL parser silently normalises 2130706433, 0x7f.1, 0177.0.0.1, ... to dotted IPv4. Refuse any
  // non-canonical numeric host outright: no legitimate merchant writes one.
  const rawHost = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0]!.replace(/^.*@/, "");
  const rawHostNoPort = rawHost.startsWith("[") ? rawHost : rawHost.replace(/:\d*$/, "");
  if (NUMERIC_HOST.test(rawHostNoPort) && !CANONICAL_V4.test(rawHostNoPort.replace(/\.$/, ""))) {
    return "webhookUrl must not use an encoded IP address";
  }
  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return "webhookUrl must have a host";
  if (isIP(host)) {
    const c = classifyIp(host);
    if (c === "forbidden") return "webhookUrl must not point at a link-local, metadata or unspecified address";
    if (c === "private" && !allowPrivate) return "webhookUrl must not point at a private or loopback address";
    return null;
  }
  if (ALWAYS_FORBIDDEN_HOSTS.has(host)) return "webhookUrl must not point at a cloud metadata service";
  if (!allowPrivate) {
    if (host === "localhost" || host.endsWith(".localhost")) return "webhookUrl must not point at localhost";
    if (/\.(internal|local|localdomain|home\.arpa|intranet|lan|corp)$/.test(host) || host.endsWith(".in-addr.arpa")) {
      return "webhookUrl must not point at an internal host name";
    }
    if (!host.includes(".")) return "webhookUrl must use a fully qualified public host name";
  }
  return null;
}

export type LookupFn = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(Object.assign(new Error("timed out"), { code: "ETIMEOUT" })), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Delivery-time check: static policy again (rows may predate the policy) plus DNS resolution, refusing
 * if any resolved address is non-public. A name that does not exist (ENOTFOUND/ENODATA) is passed
 * through: fetch will fail on the same lookup, so this adds nothing beyond the DNS-rebinding window,
 * which remains a residual risk because global fetch cannot pin the resolved address. Any other
 * resolver error fails closed (the delivery is retried with backoff).
 */
export async function deliveryTargetProblem(url: string, allowPrivate: boolean, lookup: LookupFn = defaultLookup): Promise<string | null> {
  const stat = webhookUrlProblem(url, allowPrivate);
  if (stat) return stat;
  let host = new URL(url).hostname.toLowerCase();
  if (host.startsWith("[")) host = host.slice(1, -1);
  if (isIP(host)) return null;
  let addrs: { address: string }[];
  try {
    addrs = await withTimeout(lookup(host), 5_000);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return null;
    return `could not resolve webhook host (${code ?? "error"})`;
  }
  for (const { address } of addrs) {
    const c = classifyIp(address);
    if (c === "forbidden" || (c === "private" && !allowPrivate)) return `webhook host resolves to a non-public address`;
  }
  return null;
}

// ------------------------------------------------------------------ worker

const SCAN_LIMIT = 200;
const BATCH_LIMIT = 20;
const MAX_CONCURRENCY = 8;
const PER_MERCHANT_CAP = 3;
const PER_MERCHANT_HOST_CAP = 3;
/** Global ceiling of rows aimed at one host per pass; slots are handed out round-robin across merchants. */
const PER_HOST_CEILING = 8;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect?: "manual" | "error" | "follow" },
) => Promise<{ status: number }>;

export interface WebhookWorkerOptions {
  /** ALLOW_PRIVATE_WEBHOOKS: permit loopback/private targets (local dev only). */
  allowPrivate?: boolean;
  /** Hard per-delivery timeout. */
  timeoutMs?: number;
  lookup?: LookupFn;
  /** Connect only to the addresses validated for this delivery (no second DNS lookup). Production wiring sets it. */
  pinConnections?: boolean;
}

/**
 * Delivers queued webhooks with exponential backoff. Re-signs on every attempt so the timestamp is fresh.
 * Each delivery is signed with the order's merchant secret derived from the master secret (see
 * merchantWebhookSecret). Redirects are never followed (3xx counts as a failed attempt).
 */
export class WebhookWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<number> | null = null;
  private readonly allowPrivate: boolean;
  private readonly timeoutMs: number;
  private readonly lookup: LookupFn;
  private readonly pinConnections: boolean;

  constructor(
    private readonly db: Db,
    private readonly masterSecret: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    /** Test seam. When omitted, delivery uses the pinned connection path (pinConnections) or global fetch. */
    private readonly doFetch?: FetchLike,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined,
    opts: WebhookWorkerOptions = {},
  ) {
    this.allowPrivate = opts.allowPrivate ?? false;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.lookup = opts.lookup ?? defaultLookup;
    this.pinConnections = opts.pinConnections ?? false;
  }

  start(intervalMs = 2000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs one delivery pass. Overlapping calls do not start a second pass (returns 0 instead). */
  async tick(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = this.runTick();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private merchantOf(orderId: string, body: string): string | null {
    const row = this.db.getOrder(orderId);
    if (row) return row.merchant_id;
    try {
      const m = (JSON.parse(body) as { data?: { merchantId?: unknown } }).data?.merchantId;
      return typeof m === "string" ? m : null;
    } catch {
      return null;
    }
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return "?";
    }
  }

  private async deliverOne(d: DeliveryRow): Promise<boolean> {
    let ok = false;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const pinned = this.doFetch || !this.pinConnections ? undefined : await resolveDeliveryTarget(d.url, this.allowPrivate, this.lookup);
      const problem = pinned ? pinned.problem : await deliveryTargetProblem(d.url, this.allowPrivate, this.lookup);
      const merchantId = this.merchantOf(d.order_id, d.body);
      if (problem) {
        this.log("webhook target refused", { id: d.id, reason: problem });
      } else if (!merchantId) {
        this.log("webhook has no merchant", { id: d.id });
      } else {
        const headers = {
          "content-type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: signWebhook(merchantWebhookSecret(this.masterSecret, merchantId), d.body, this.now()),
        };
        // Abort signal for well-behaved fetches, plus a race so a fetch that ignores it cannot stall the worker.
        const res = pinned
          ? await pinnedPost(d.url, pinned.addresses, { headers, body: d.body, timeoutMs: this.timeoutMs, signal: ctl.signal, allowPrivate: this.allowPrivate })
          : await withTimeout((this.doFetch ?? ((u, i) => fetch(u, i)))(d.url, { method: "POST", headers, body: d.body, signal: ctl.signal, redirect: "manual" }), this.timeoutMs);
        ok = res.status >= 200 && res.status < 300;
      }
    } catch (e) {
      this.log("webhook delivery error", { id: d.id, err: String((e as Error).message).slice(0, 200) });
    } finally {
      clearTimeout(t);
    }
    if (ok) {
      this.db.markDelivered(d.id, this.now());
    } else {
      const idx = Math.min(d.attempts, DELIVERY_BACKOFF_SECONDS.length - 1);
      this.db.markAttempt(d.id, this.now() + DELIVERY_BACKOFF_SECONDS[idx]!);
      if (d.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) this.log("webhook gave up", { id: d.id });
    }
    return ok;
  }

  /**
   * One pass: due rows (oldest first) are selected fairly, at most PER_MERCHANT_CAP per merchant and PER_HOST_CAP per
   * host per pass (the rest stay due, untouched, for the next pass), and delivered by a pool of MAX_CONCURRENCY
   * workers. A tarpit endpoint therefore delays only its own deliveries; each row is still attempted once per pass,
   * so retry/backoff accounting is unchanged.
   */
  private async runTick(): Promise<number> {
    // Per-merchant oldest rows (rows ordered by per-merchant rank, so one merchant's backlog cannot crowd out others),
    // then taken round-robin across merchants under the per-(merchant,host) cap and the global per-host ceiling.
    const due = this.db.dueDeliveriesFair(this.now(), PER_MERCHANT_CAP * 4, SCAN_LIMIT);
    const perMerchant = new Map<string, number>();
    const perMerchantHost = new Map<string, number>();
    const perHost = new Map<string, number>();
    const batch: DeliveryRow[] = [];
    const queues = new Map<string, DeliveryRow[]>();
    for (const d of due) {
      const m = this.merchantOf(d.order_id, d.body)?.toLowerCase() ?? `order:${d.order_id}`;
      const q = queues.get(m);
      if (q) q.push(d);
      else queues.set(m, [d]);
    }
    let progress = true;
    while (progress && batch.length < BATCH_LIMIT) {
      progress = false;
      for (const [m, q] of queues) {
        while (q.length > 0) {
          const d = q.shift()!;
          const h = this.hostOf(d.url);
          const mh = `${m}|${h}`;
          if ((perMerchant.get(m) ?? 0) >= PER_MERCHANT_CAP) {
            q.length = 0;
            break;
          }
          if ((perMerchantHost.get(mh) ?? 0) >= PER_MERCHANT_HOST_CAP || (perHost.get(h) ?? 0) >= PER_HOST_CEILING) continue;
          perMerchant.set(m, (perMerchant.get(m) ?? 0) + 1);
          perMerchantHost.set(mh, (perMerchantHost.get(mh) ?? 0) + 1);
          perHost.set(h, (perHost.get(h) ?? 0) + 1);
          batch.push(d);
          progress = true;
          break;
        }
        if (batch.length >= BATCH_LIMIT) break;
      }
    }
    let delivered = 0;
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const d = batch[next++]!;
        if (await this.deliverOne(d)) delivered += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, batch.length) }, worker));
    return delivered;
  }
}
