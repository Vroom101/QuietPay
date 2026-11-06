import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { classifyIp, webhookUrlProblem, type LookupFn } from "./webhooks.js";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Webhook connection pinning. The delivery path resolves the host ONCE, checks every answer against the
 * SSRF policy, and then connects only to those checked addresses. The socket never asks DNS again, so a
 * resolver that answers public at validation time and private at connect time (DNS rebinding) cannot
 * redirect the delivery. The URL, Host header and TLS server name (SNI and certificate check) stay the
 * original host name. Redirects are never followed.
 */

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface DeliveryTarget {
  problem: string | null;
  /** The validated addresses to connect to (empty when `problem` is set). */
  addresses: string[];
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(Object.assign(new Error("timed out"), { code: "ETIMEOUT" })), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Static URL policy, then one DNS resolution; every resolved address must be public (private ones pass only
 * with allowPrivate; link-local, metadata and unspecified never). An unresolvable name is refused because
 * there is nothing to pin. An IP literal pins to itself.
 */
export async function resolveDeliveryTarget(url: string, allowPrivate: boolean, lookup: LookupFn = defaultLookup): Promise<DeliveryTarget> {
  const refuse = (problem: string): DeliveryTarget => ({ problem, addresses: [] });
  const stat = webhookUrlProblem(url, allowPrivate);
  if (stat) return refuse(stat);
  let host = new URL(url).hostname.toLowerCase();
  if (host.startsWith("[")) host = host.slice(1, -1);
  if (isIP(host)) return { problem: null, addresses: [host] };
  let answers: { address: string }[];
  try {
    answers = await timeout(lookup(host), 5_000);
  } catch (e) {
    return refuse(`could not resolve webhook host (${(e as { code?: string }).code ?? "error"})`);
  }
  if (answers.length === 0) return refuse("webhook host did not resolve");
  const addresses: string[] = [];
  for (const { address } of answers) {
    const c = classifyIp(address);
    if (c === "forbidden" || (c === "private" && !allowPrivate)) return refuse("webhook host resolves to a non-public address");
    addresses.push(address);
  }
  return { problem: null, addresses };
}

const canon = (ip: string) => ip.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");
const sameIp = (a: string, b: string) => canon(a) === canon(b);

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void;

/** A dns.lookup replacement that can only ever answer with the validated addresses for the validated host. */
export function makePinnedLookup(host: string, addresses: string[]) {
  const want = host.toLowerCase().replace(/\.$/, "");
  return (hostname: string, opts: { all?: boolean; family?: number | string } | undefined, cb: LookupCb): void => {
    if (hostname.toLowerCase().replace(/\.$/, "") !== want) {
      cb(Object.assign(new Error("pinned lookup: unexpected host"), { code: "EPINNED" }));
      return;
    }
    const fam = opts?.family === 4 || opts?.family === "IPv4" ? 4 : opts?.family === 6 || opts?.family === "IPv6" ? 6 : 0;
    const list = addresses.map((address) => ({ address, family: isIP(address) })).filter((a) => fam === 0 || a.family === fam);
    if (list.length === 0) {
      cb(Object.assign(new Error("pinned lookup: no address for family"), { code: "ENOTFOUND" }));
      return;
    }
    if (opts?.all) cb(null, list);
    else cb(null, list[0]!.address, list[0]!.family);
  };
}

export interface PinnedPostOptions {
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Allow private addresses when double-checking the connected socket (local dev). */
  allowPrivate?: boolean;
}

/** POSTs to `url`, connecting only to `addresses`. Resolves with the status; the response body is discarded. */
export function pinnedPost(url: string, addresses: string[], opts: PinnedPostOptions): Promise<{ status: number }> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  let host = u.hostname;
  if (host.startsWith("[")) host = host.slice(1, -1);
  const ms = opts.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        protocol: u.protocol,
        hostname: host,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: { ...opts.headers, "content-length": String(Buffer.byteLength(opts.body)) },
        lookup: makePinnedLookup(host, addresses) as never,
        agent: false,
        signal: opts.signal,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        done(() => resolve({ status }));
      },
    );
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEOUT" }));
    }, ms);
    req.on("socket", (sock) => {
      // Defence in depth: whatever the socket really connected to must be one of the validated addresses.
      sock.once("connect", () => {
        const ra = sock.remoteAddress;
        if (ra && !addresses.some((x) => sameIp(x, ra))) {
          req.destroy(Object.assign(new Error("connected to an unvalidated address"), { code: "EPINNED" }));
        }
      });
    });
    req.on("error", (e) => done(() => reject(e)));
    req.end(opts.body);
  });
}
