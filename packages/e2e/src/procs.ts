import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { keccak256, type Hex } from "viem";
import { merchantWebhookSecretFor } from "./webhook-secret.js";
import { redact, repoRoot, sleep, waitUntil } from "./util.js";

// ---------------------------------------------------------------------------------------------- tracked processes

const tracked = new Map<number, ChildProcess>();
/** Kills ONE process by the PID this harness started. Never by name. */
export function killPid(pid: number | undefined) {
  if (pid === undefined) return;
  const c = tracked.get(pid);
  if (c) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
    tracked.delete(pid);
  }
}
export function killAllTracked() {
  for (const pid of [...tracked.keys()]) killPid(pid);
}

export async function assertPortFree(port: number): Promise<void> {
  // A just-killed process may need a moment to release its port: retry briefly before failing.
  for (let i = 0; ; i++) {
    try {
      await new Promise<void>((res, rej) => {
        const s = createNetServer();
        s.once("error", rej);
        s.listen(port, "127.0.0.1", () => s.close(() => res()));
      });
      return;
    } catch {
      if (i >= 10) throw new Error(`port ${port} is in use; pick another E2E_PORT_BASE`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export async function waitForRpc(url: string, tries = 150) {
  await waitUntil(async () => {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      return r.ok;
    } catch { return false; }
  }, `RPC ${redact(url)}`, tries * 100, 100);
}

export class AnvilProc {
  child?: ChildProcess;
  constructor(readonly port: number, readonly chainId = 1874) {}
  get url() { return `http://127.0.0.1:${this.port}`; }
  get pid() { return this.child?.pid; }
  async start() {
    await assertPortFree(this.port);
    // Chain id 1874: the relayer, indexer and verifier entries refuse any other chain.
    this.child = spawn("anvil", ["--port", String(this.port), "--chain-id", String(this.chainId), "--silent"], { stdio: "ignore" });
    if (this.child.pid) tracked.set(this.child.pid, this.child);
    await waitForRpc(this.url);
  }
  stop() { killPid(this.pid); }
}

// ---------------------------------------------------------------------------------------------- relayer child

export interface RelayerOpts {
  port: number;
  /** Complete child environment (PATH is added). Only these variables reach the child. */
  env: Record<string, string>;
  logDir: string;
  name: string;
}

/** The real relayer entry (packages/relayer/src/index.ts) as a child process this harness owns. */
export class RelayerProc {
  child?: ChildProcess;
  private out?: WriteStream;
  constructor(readonly o: RelayerOpts) {}
  get url() { return `http://127.0.0.1:${this.o.port}`; }
  get pid() { return this.child?.pid; }
  async start(envOverride: Record<string, string> = {}) {
    await assertPortFree(this.o.port);
    mkdirSync(this.o.logDir, { recursive: true });
    this.out = createWriteStream(resolve(this.o.logDir, `${this.o.name}.log`), { flags: "a" });
    const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...this.o.env, ...envOverride, PORT: String(this.o.port) } as Record<string, string>;
    this.child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: resolve(repoRoot, "packages/relayer"), env, stdio: ["ignore", "pipe", "pipe"] });
    if (this.child.pid) tracked.set(this.child.pid, this.child);
    const pipe = (d: Buffer) => this.out?.write(redact(d.toString()));
    this.child.stdout!.on("data", pipe);
    this.child.stderr!.on("data", pipe);
    await waitUntil(async () => {
      if (this.child!.exitCode !== null) throw new Error(`relayer exited early (code ${this.child!.exitCode}); see ${this.o.logDir}`);
      try { return (await fetch(`${this.url}/v1/health`)).ok; } catch { return false; }
    }, "relayer /v1/health", 60_000, 200);
  }
  /** SIGKILL: no graceful shutdown, as in a crash. */
  kill() {
    killPid(this.pid);
    this.out?.end();
  }
}

// ---------------------------------------------------------------------------------------------- webhook sink

export interface SinkHit { body: string; sig: string; status: number; at: number }

/** Merchant-side webhook receiver. `failNext(n)` answers the next n deliveries with 503 (a down merchant). */
export class WebhookSink {
  hits: SinkHit[] = [];
  private failures = 0;
  private server?: Server;
  constructor(readonly port: number) {}
  get url() { return `http://127.0.0.1:${this.port}/hook`; }
  failNext(n: number) { this.failures = n; }
  get accepted() { return this.hits.filter((h) => h.status === 200); }
  async start() {
    await assertPortFree(this.port);
    this.server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const status = this.failures > 0 ? 503 : 200;
        if (this.failures > 0) this.failures -= 1;
        this.hits.push({ body: b, sig: String(req.headers["quietpay-signature"] ?? ""), status, at: Date.now() });
        res.writeHead(status).end(status === 200 ? "ok" : "down");
      });
    });
    await new Promise<void>((r) => this.server!.listen(this.port, "127.0.0.1", r));
  }
  stop() { this.server?.close(); this.server?.closeAllConnections?.(); }
}

// ---------------------------------------------------------------------------------------------- faulty RPC proxy

export type ProxyMode = "pass" | "drop-after-send" | "hang-after-send";

/**
 * JSON-RPC proxy in front of the node. For eth_sendRawTransaction it can forward the transaction (the node
 * ACCEPTS it) and then close the socket without a reply ("drop-after-send") or hold the reply open
 * ("hang-after-send"), simulating an uncertain broadcast or a relayer killed mid-send.
 */
export class FaultyRpc {
  mode: ProxyMode = "pass";
  /** How many sendRawTransaction calls still misbehave before the proxy goes back to passing. */
  remaining = 0;
  sent: { raw: Hex; hash: Hex }[] = [];
  faulted: Hex[] = [];
  private server?: Server;
  private held = new Set<ServerResponse>();
  private sockets = new Set<Socket>();
  constructor(readonly port: number, readonly target: string) {}
  get url() { return `http://127.0.0.1:${this.port}`; }
  arm(mode: ProxyMode, times = 1) { this.mode = mode; this.remaining = times; }
  async start() {
    await assertPortFree(this.port);
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
    await new Promise<void>((r) => this.server!.listen(this.port, "127.0.0.1", r));
  }
  /** Closes the replies held open by "hang-after-send" (the node already has those transactions). */
  releaseHeld() {
    for (const r of this.held) r.destroy();
    this.held.clear();
  }
  stop() {
    for (const r of this.held) r.destroy();
    for (const s of this.sockets) s.destroy();
    this.server?.close();
  }
  private forward(body: string): Promise<{ status: number; text: string }> {
    const u = new URL(this.target);
    return new Promise((res, rej) => {
      const r = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (rr: IncomingMessage) => {
        let t = "";
        rr.on("data", (c) => (t += c));
        rr.on("end", () => res({ status: rr.statusCode ?? 200, text: t }));
      });
      r.on("error", rej);
      r.end(body);
    });
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    let body = "";
    for await (const c of req) body += c;
    let raw: Hex | undefined;
    try {
      const j = JSON.parse(body) as { method?: string; params?: unknown[] };
      if (!Array.isArray(j) && j.method === "eth_sendRawTransaction") raw = j.params?.[0] as Hex;
    } catch { /* pass through */ }
    let out: { status: number; text: string };
    try { out = await this.forward(body); } catch { res.destroy(); return; }
    if (raw) {
      const hash = keccak256(raw);
      if (!this.sent.some((s) => s.hash === hash)) this.sent.push({ raw, hash });
      if (this.mode !== "pass" && this.remaining > 0) {
        this.remaining -= 1;
        this.faulted.push(hash);
        if (this.mode === "drop-after-send") { res.socket?.destroy(); return; }
        this.held.add(res); // hang-after-send: the node has the tx, the client never hears back
        return;
      }
    }
    res.writeHead(out.status, { "content-type": "application/json" }).end(out.text);
  }
}

export { merchantWebhookSecretFor, sleep };
