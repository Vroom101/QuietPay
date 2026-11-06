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
