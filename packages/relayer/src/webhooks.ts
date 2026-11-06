import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from "@quietpay/shared/webhook";
import { DELIVERY_BACKOFF_SECONDS, MAX_DELIVERY_ATTEMPTS, type Db } from "./db.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;

/** Delivers queued webhooks with exponential backoff. Re-signs on every attempt so the timestamp is fresh. */
export class WebhookWorker {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly doFetch: FetchLike = (url, init) => fetch(url, init),
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined,
  ) {}

  start(intervalMs = 2000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<number> {
    const due = this.db.dueDeliveries(this.now());
    let delivered = 0;
    for (const d of due) {
      let ok = false;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 10_000);
        const res = await this.doFetch(d.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WEBHOOK_SIGNATURE_HEADER]: signWebhook(this.secret, d.body, this.now()),
          },
          body: d.body,
          signal: ctl.signal,
        });
        clearTimeout(t);
        ok = res.status >= 200 && res.status < 300;
      } catch (e) {
        this.log("webhook delivery error", { id: d.id, err: String((e as Error).message).slice(0, 200) });
      }
      if (ok) {
        this.db.markDelivered(d.id, this.now());
        delivered += 1;
      } else {
        const idx = Math.min(d.attempts, DELIVERY_BACKOFF_SECONDS.length - 1);
        this.db.markAttempt(d.id, this.now() + DELIVERY_BACKOFF_SECONDS[idx]!);
        if (d.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) this.log("webhook gave up", { id: d.id });
      }
    }
    return delivered;
  }
}
