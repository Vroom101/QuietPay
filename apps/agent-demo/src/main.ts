import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { token } from "@quietpay/shared";
import {
  AgentError,
  createAgent,
  httpFacilitatorLookup,
  viemChainEvidence,
  type AgentOptions,
} from "@quietpay/agent-client";
import { runDemo } from "./demo.js";

async function main() {
  const env = z
    .object({
      AGENT_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      PAID_API_PUBLIC_URL: z.string().url(),
      FACILITATOR_PAYTO: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      RPC_URL: z.string().url(),
      AGENT_PER_CALL_LIMIT: z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .default("20000"),
      AGENT_SESSION_BUDGET: z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .default("30000"),
      AGENT_EXPLORER_URL: z.string().url(),
      // Opt-in crash-safe state. The secret keys the store's integrity MACs; it is never written to disk.
      AGENT_STORE_PATH: z.string().min(1).optional(),
      AGENT_STORE_SECRET: z.string().min(16).optional(),
      FACILITATOR_URL: z.string().url().optional(),
    })
    .parse(process.env);
  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);
  const pub = createPublicClient({ transport: http(env.RPC_URL) });
  if ((await pub.getChainId()) !== token.chainId)
    throw new Error("RPC is on the wrong chain");
  const before = await pub.getBalance({ address: account.address });
  if (before !== 0n)
    throw new Error(
      "Use a dedicated demo payer with USDT and zero native currency",
    );
  const agentOptions: AgentOptions = {
    signer: account,
    chainId: token.chainId,
    asset: getAddress(token.address),
    domainName: token.eip712Domain.name,
    domainVersion: token.eip712Domain.version,
    allowedOrigins: [new URL(env.PAID_API_PUBLIC_URL).origin],
    allowedPayTo: [getAddress(env.FACILITATOR_PAYTO)],
    perCallLimit: BigInt(env.AGENT_PER_CALL_LIMIT),
    sessionBudget: BigInt(env.AGENT_SESSION_BUDGET),
    explorerUrl: env.AGENT_EXPLORER_URL,
  };
  if (env.AGENT_STORE_PATH) {
    if (!env.AGENT_STORE_SECRET)
      throw new Error("AGENT_STORE_SECRET is required with AGENT_STORE_PATH");
    agentOptions.store = {
      path: env.AGENT_STORE_PATH,
      secret: env.AGENT_STORE_SECRET,
      chain: viemChainEvidence(pub as PublicClient),
      facilitator: env.FACILITATOR_URL
        ? httpFacilitatorLookup(env.FACILITATOR_URL)
        : undefined,
    };
  }
  const agent = createAgent(agentOptions);
  // A restarted agent first resolves anything left in flight (same nonce, never a new one).
  if (agentOptions.store && "recover" in agent)
    console.log(
      JSON.stringify({
        recovered: await (agent as unknown as { recover(): Promise<unknown> }).recover(),
      }),
    );
  console.log(
    JSON.stringify({
      payer: account.address,
      nativeBalance: before.toString(),
      sessionBudget: env.AGENT_SESSION_BUDGET,
    }),
  );
  try {
    await runDemo(agent, env.PAID_API_PUBLIC_URL, {
      emit: (entry) => console.log(JSON.stringify(entry)),
    });
    for (const payment of agent.payments) {
      if (!payment.transaction) throw new Error("Missing transaction receipt");
      const receipt = await pub.getTransactionReceipt({
        hash: payment.transaction,
      });
      if (receipt.status !== "success")
        throw new Error("Settlement transaction did not succeed");
    }
    const after = await pub.getBalance({ address: account.address });
    if (after !== 0n) throw new Error("Demo payer native balance changed");
    console.log(
      JSON.stringify({
        completed: true,
        authorizedAmount: agent.reservedAmount.toString(),
        nativeBalance: after.toString(),
      }),
    );
  } finally {
    // Only public receipts are printed. The authorization payload and private key stay in memory.
    console.log(JSON.stringify({ payments: agent.payments }));
  }
}
main().catch((error) => {
  if (error instanceof AgentError)
    console.error(
      JSON.stringify({
        code: error.code,
        message: error.message,
        paymentId: error.paymentId,
      }),
    );
  else
    console.error(
      error instanceof z.ZodError
        ? "Missing or invalid agent environment configuration"
        : error instanceof Error
          ? error.message
          : "Agent demo failed",
    );
  process.exitCode = 1;
});
