import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getAddress, isAddress, verifyMessage } from "viem";
import { createCostLimiter, ipKey } from "./customer-refunds.js";

type Hex = `0x${string}`;

export interface MerchantAuthConfig {
  /** Wallets that may sign in as the merchant. */
  wallets: string[];
  /** EIP-4361 domain and URI shown in the signed message. */
  domain: string;
  uri: string;
  chainId: number;
  /** Session lifetime in seconds (default 8 h). */
  sessionSeconds?: number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 10_000;
const MAX_SESSIONS = 10_000;
const LIMIT = 20;
const WINDOW_MS = 60_000;
const BODY_LIMIT = 2048;
const FAILED: { error: string } = { error: "sign-in failed" };
const NONCE = /^[0-9a-f]{32}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
// A valid-looking but never-allowed identity, so unknown nonces cost the same verification work as real ones.
const DUMMY_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Hex;
const DUMMY_SIGNATURE = ("0x" + "11".repeat(64) + "1b") as Hex;

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const bearer = (header: string | undefined) => header?.match(/^Bearer (.+)$/)?.[1] ?? "";

interface Challenge { message: string; address: string; expiresAt: number }
interface Session { address: string; expiresAt: number; digest: Buffer }

export function createMerchantAuth(config: MerchantAuthConfig, now: () => number = Date.now) {
  const allowed = new Set(config.wallets.filter((w) => isAddress(w, { strict: false })).map((w) => w.toLowerCase()));
  const sessionMs = (config.sessionSeconds ?? 8 * 3600) * 1000;
  const challenges = new Map<string, Challenge>();
  const sessions = new Map<string, Session>();
  const limiter = createCostLimiter(LIMIT, WINDOW_MS, now);

  function evict<T extends { expiresAt: number }>(map: Map<string, T>, max: number) {
    if (map.size < max) return;
    const t = now();
    for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k);
    while (map.size >= max) map.delete(map.keys().next().value as string);
  }

  function sessionFor(token: string): Session | undefined {
    if (!token) return undefined;
    const digest = sha256(token);
    const s = sessions.get(digest.toString("hex"));
    if (!s) return undefined;
    if (!timingSafeEqual(s.digest, digest)) return undefined;
    if (s.expiresAt <= now()) {
      sessions.delete(digest.toString("hex"));
      return undefined;
    }
    return s;
  }

  const enabled = allowed.size > 0;

  function register(app: FastifyInstance) {
    const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");
    const limited = (reply: FastifyReply) =>
      noStore(reply).header("Retry-After", Math.ceil(WINDOW_MS / 1000)).code(429).send({ error: "rate_limited" });

    app.post("/api/merchant/auth/challenge", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      noStore(reply);
      const ip = ipKey(req.ip);
      if (limiter.blocked(ip)) return limited(reply);
      limiter.add(ip, 1);
      const raw = (req.body as { address?: unknown } | null)?.address;
      if (typeof raw !== "string" || raw.length > 42 || !isAddress(raw, { strict: false }))
        return reply.code(400).send({ error: "invalid request" });
      const address = getAddress(raw);
      const nonce = randomBytes(16).toString("hex");
      const issued = now();
      const expiresAt = issued + CHALLENGE_TTL_MS;
      const message = [
        `${config.domain} wants you to sign in with your Ethereum account:`,
        address,
        "",
        "Sign in to the QuietPay merchant dashboard. This does not cost gas.",
        "",
        `URI: ${config.uri}`,
        "Version: 1",
        `Chain ID: ${config.chainId}`,
        `Nonce: ${nonce}`,
        `Issued At: ${new Date(issued).toISOString()}`,
        `Expiration Time: ${new Date(expiresAt).toISOString()}`,
      ].join("\n");
      // Allowed or not, the answer looks the same; the allowlist is only checked when the signature comes back.
      evict(challenges, MAX_CHALLENGES);
      challenges.set(nonce, { message, address: address.toLowerCase(), expiresAt });
      return { nonce, message };
    });

    app.post("/api/merchant/auth/verify", { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      noStore(reply);
      const ip = ipKey(req.ip);
      if (limiter.blocked(ip)) return limited(reply);
      limiter.add(ip, 1);
      const fail = () => {
        limiter.add(ip, 1); // a failed attempt costs double
        return reply.code(401).send(FAILED);
      };
      const body = (req.body ?? {}) as { nonce?: unknown; signature?: unknown };
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      const signature = typeof body.signature === "string" ? body.signature : "";
      const wellFormed = NONCE.test(nonce) && SIGNATURE.test(signature);
      const stored = wellFormed ? challenges.get(nonce) : undefined;
      if (stored) challenges.delete(nonce); // single use: a replay or a failed attempt burns it
      const usable = stored !== undefined && stored.expiresAt > now();
      let valid = false;
      try {
        // Always run one verification, against the STORED message (never the client's), so every path costs the same.
        valid = await verifyMessage({
          address: (usable ? stored!.address : DUMMY_ADDRESS) as Hex,
          message: usable ? stored!.message : "invalid",
          signature: (wellFormed ? signature : DUMMY_SIGNATURE) as Hex,
        });
      } catch {
        valid = false;
      }
      if (!usable || !valid || !allowed.has(stored!.address)) return fail();
      const token = randomBytes(32).toString("base64url");
      const digest = sha256(token);
      const expiresAt = now() + sessionMs;
      evict(sessions, MAX_SESSIONS);
      sessions.set(digest.toString("hex"), { address: stored!.address, expiresAt, digest });
      return { token, address: stored!.address, expiresAt };
    });

    app.get("/api/merchant/auth/me", async (req, reply) => {
      noStore(reply);
      const s = sessionFor(bearer(req.headers.authorization));
      if (!s) return reply.code(401).send(FAILED);
      return { address: s.address, expiresAt: s.expiresAt };
    });

    app.post("/api/merchant/auth/logout", async (req, reply) => {
      noStore(reply);
      const token = bearer(req.headers.authorization);
      if (token) sessions.delete(sha256(token).toString("hex"));
      return { ok: true };
    });
  }

  return { enabled, register, isSession: (token: string) => sessionFor(token) !== undefined };
}
