import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { cents, fromCents } from "../src/products.js";
import type { DemoInvoice, DemoOrder, DemoPlan, DemoRefund, DemoSubscription } from "../src/billing.js";

function clean(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length <= maxLength ? value.trim() : "";
}

function amountInCents(value: unknown): number {
  return typeof value === "string" && /^\d{1,7}(?:\.\d{1,2})?$/.test(value) ? cents(value) : 0;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function nextCharge(interval: DemoPlan["interval"]): string {
  const now = new Date();
  const originalDay = now.getUTCDate();
  now.setUTCDate(1);
  now.setUTCMonth(now.getUTCMonth() + (interval === "month" ? 1 : 12));
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  now.setUTCDate(Math.min(originalDay, lastDay));
  return now.toISOString();
}

export function registerDemoBilling(app: FastifyInstance, listPayments: () => Omit<DemoOrder, "refunds">[]) {
  const refunds = new Map<string, DemoRefund[]>();
  const invoices = new Map<string, DemoInvoice>();
  const plans = new Map<string, DemoPlan>();
  const subscriptions = new Map<string, DemoSubscription>();

  app.get("/api/demo/merchant/orders", async () => ({
    orders: listPayments().map((order) => ({ ...order, refunds: refunds.get(order.id) ?? [] })),
  }));

  app.post<{ Params: { id: string }; Body: { amount?: unknown; requestId?: unknown } }>(
    "/api/demo/merchant/orders/:id/refunds", async (req, reply) => {
      const order = listPayments().find((entry) => entry.id === req.params.id);
      if (!order) return reply.code(404).send({ error: "A completed demo order is required." });
      const amount = amountInCents(req.body?.amount);
      const requestId = clean(req.body?.requestId, 60);
      if (!amount || !requestId) return reply.code(400).send({ error: "Enter a valid refund amount." });
      const history = refunds.get(order.id) ?? [];
      const existing = history.find((refund) => refund.id === requestId);
      if (existing) {
        if (cents(existing.amount) !== amount) return reply.code(409).send({ error: "This refund request was already used." });
        return existing;
      }
      const remaining = cents(order.amount) - history.reduce((sum, entry) => sum + cents(entry.amount), 0);
      if (amount > remaining) return reply.code(409).send({ error: "The refund exceeds the remaining balance." });
      const refund = { id: requestId, amount: fromCents(amount), createdAt: Date.now() };
      refunds.set(order.id, [...history, refund]);
      return refund;
    },
  );

  app.get("/api/demo/merchant/invoices", async () => ({ invoices: [...invoices.values()].reverse() }));
  app.post<{ Body: { kind?: unknown; client?: unknown; description?: unknown; amount?: unknown; dueDate?: unknown; reminderDays?: unknown } }>(
    "/api/demo/merchant/invoices", async (req, reply) => {
      const kind = req.body?.kind ?? "invoice";
      const client = clean(req.body?.client, 120);
      const description = clean(req.body?.description, 240);
      const dueDate = clean(req.body?.dueDate, 10);
      const amount = amountInCents(req.body?.amount);
      const reminderDays = req.body?.reminderDays ?? null;
      if ((kind !== "invoice" && kind !== "link") || !description || !amount ||
        (kind === "invoice" && (!client || !isDate(dueDate) || (reminderDays !== null && ![1, 3, 7].includes(reminderDays as number))))) {
        return reply.code(400).send({ error: "Enter a description and amount. Invoices also require a client and due date." });
      }
      const invoice: DemoInvoice = {
        id: randomUUID(), kind, client: kind === "invoice" ? client : "", description, amount: fromCents(amount),
        dueDate: kind === "invoice" ? dueDate : null, reminderDays: kind === "invoice" ? reminderDays as number | null : null,
      };
      invoices.set(invoice.id, invoice);
      return reply.code(201).send(invoice);
    },
  );

  app.get<{ Params: { id: string } }>("/api/demo/invoices/:id", async (req, reply) =>
    invoices.get(req.params.id) ?? reply.code(404).send({ error: "This invoice link is unavailable." }),
  );

  app.get("/api/demo/merchant/plans", async () => ({ plans: [...plans.values()].reverse() }));
  app.get("/api/demo/merchant/subscriptions", async () => ({ subscriptions: [...subscriptions.values()].reverse() }));
  app.post<{ Body: { name?: unknown; amount?: unknown; interval?: unknown } }>("/api/demo/merchant/plans", async (req, reply) => {
    const name = clean(req.body?.name, 120);
    const amount = amountInCents(req.body?.amount);
    const interval = req.body?.interval;
    if (!name || !amount || (interval !== "month" && interval !== "year")) return reply.code(400).send({ error: "Enter a plan name, amount and billing interval." });
    const plan: DemoPlan = { id: randomUUID(), name, amount: fromCents(amount), interval };
    plans.set(plan.id, plan);
    return reply.code(201).send(plan);
  });
  app.get<{ Params: { id: string } }>("/api/demo/plans/:id", async (req, reply) =>
    plans.get(req.params.id) ?? reply.code(404).send({ error: "This subscription plan is unavailable." }),
  );
  app.post<{ Params: { id: string }; Body: { consent?: unknown; requestId?: unknown } }>("/api/demo/plans/:id/subscribe", async (req, reply) => {
    const plan = plans.get(req.params.id);
    if (!plan) return reply.code(404).send({ error: "This subscription plan is unavailable." });
    const id = clean(req.body?.requestId, 60);
    if (req.body?.consent !== true || !/^[a-f0-9-]{36}$/.test(id)) return reply.code(400).send({ error: "Confirm the recurring terms first." });
    const existing = subscriptions.get(id);
    if (existing) return existing.plan.id === plan.id ? existing : reply.code(409).send({ error: "This signup request was already used." });
    const subscription: DemoSubscription = { id, plan, status: "active", nextCharge: nextCharge(plan.interval) };
    subscriptions.set(id, subscription);
    return reply.code(201).send(subscription);
  });
  app.get<{ Params: { id: string } }>("/api/demo/subscriptions/:id", async (req, reply) =>
    subscriptions.get(req.params.id) ?? reply.code(404).send({ error: "This subscription is unavailable." }),
  );
  app.post<{ Params: { id: string } }>("/api/demo/subscriptions/:id/cancel", async (req, reply) => {
    const subscription = subscriptions.get(req.params.id);
    if (!subscription) return reply.code(404).send({ error: "This subscription is unavailable." });
    subscription.status = "cancelled";
    subscription.nextCharge = null;
    return subscription;
  });

  return {
    getInvoice: (id: string) => invoices.get(id),
    getRefunds: (id: string) => refunds.get(id) ?? [],
  };
}
