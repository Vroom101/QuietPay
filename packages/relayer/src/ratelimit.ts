/** Sliding-window rate limiter keyed by string. In-memory; resets on restart. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true if allowed (and records the hit), false if over the limit. */
  allow(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((x) => x > cutoff);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 50_000) this.prune(cutoff);
    return true;
  }

  private prune(cutoff: number) {
    for (const [k, v] of this.hits) {
      if (v.every((x) => x <= cutoff)) this.hits.delete(k);
    }
  }
}

/** Expands an IPv6 address (no zone id) to eight 16-bit groups, or returns null if it does not parse. */
function ipv6Groups(addr: string): number[] | null {
  let s = addr;
  // Trailing dotted IPv4 (e.g. ::ffff:1.2.3.4) becomes two hex groups.
  const m = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (m) {
    const o = m.slice(2, 6).map(Number);
    if (o.some((x) => x > 255)) return null;
    s = `${m[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Rate-limit key for a client address. IPv4 is keyed exactly; an IPv4-mapped IPv6 address (::ffff:a.b.c.d,
 * also in hex groups) is keyed as that IPv4 address; any other IPv6 address is keyed by its /64, since one
 * host normally owns a whole /64 and could otherwise rotate through 2^64 addresses to reset per-IP limits.
 * Only the socket address is ever passed in here (X-Forwarded-For is never trusted).
 */
export function clientKey(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(":")) return raw; // IPv4 (or an unparseable string, keyed as is)
  const g = ipv6Groups(raw.replace(/^\[|\]$/g, "").split("%")[0]);
  if (!g) return raw;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
