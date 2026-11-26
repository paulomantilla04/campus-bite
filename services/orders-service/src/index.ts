import { basename } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { menuClient } from "./clients/menuClient";
import { db, dbPath, sqlite } from "./db";
import { ORDER_STATUSES, orderItems, orders, type OrderStatus, type OrderWithItems } from "./db/schema";
import { getBrokerStatus, isBrokerConnected, publishEvent, startBroker, stopBroker, type OrderEventType } from "./events/broker";

const PORT = Number(process.env.PORT ?? 3002);
const SERVICE = "orders-service";
const startedAt = Date.now();

type Env = { Variables: { correlationId: string } };

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: SERVICE, msg, ...extra }));
}

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["delivered"],
  delivered: [],
  cancelled: [],
};

const createOrderSchema = z.object({
  studentName: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        menuItemId: z.number().int().positive(),
        quantity: z.number().int().positive().max(50),
      }),
    )
    .min(1),
});

const updateStatusSchema = z.object({ status: z.enum(ORDER_STATUSES) });

const listQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  studentName: z.string().trim().min(1).optional(),
});

function attachItems(rows: (typeof orders.$inferSelect)[]): OrderWithItems[] {
  if (rows.length === 0) return [];
  const items = db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, rows.map((r) => r.id)))
    .orderBy(orderItems.id)
    .all();
  return rows.map((r) => ({ ...r, items: items.filter((it) => it.orderId === r.id) }));
}

function getOrder(id: number): OrderWithItems | null {
  const row = db.select().from(orders).where(eq(orders.id, id)).get();
  return row ? attachItems([row])[0]! : null;
}

function itemsSummary(order: OrderWithItems) {
  return order.items.map((it) => `${it.quantity}x ${it.itemName}`).join(", ");
}

function emit(eventType: OrderEventType, order: OrderWithItems, correlationId: string, previousStatus?: OrderStatus) {
  return publishEvent({
    eventId: crypto.randomUUID(),
    eventType,
    routingKey: eventType,
    correlationId,
    sourceService: SERVICE,
    occurredAt: new Date().toISOString(),
    payload: {
      orderId: order.id,
      orderCode: order.orderCode,
      studentName: order.studentName,
      status: order.status,
      ...(previousStatus ? { previousStatus } : {}),
      totalCents: order.totalCents,
      itemsSummary: itemsSummary(order),
    },
  });
}

function parseId(raw: string) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const app = new Hono<Env>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Correlation-Id"],
    exposeHeaders: ["X-Correlation-Id"],
  }),
);

app.use("*", async (c, next) => {
  const correlationId = c.req.header("X-Correlation-Id")?.trim() || crypto.randomUUID();
  c.set("correlationId", correlationId);
  c.header("X-Correlation-Id", correlationId);
  const start = performance.now();
  await next();
  c.header("X-Correlation-Id", correlationId);
  log("info", "request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Math.round(performance.now() - start),
    correlationId,
  });
});

app.get("/health", (c) => {
  const orderCount = db.select({ n: sql<number>`count(*)` }).from(orders).get()?.n ?? 0;
  return c.json({
    service: SERVICE,
    status: isBrokerConnected() ? "healthy" : "degraded",
    database: { engine: "sqlite", file: basename(dbPath), status: "ok", orderCount },
    broker: getBrokerStatus(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

app.get("/orders", (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "invalid query", details: parsed.error.issues, correlationId: c.get("correlationId") }, 400);
  }
  const { status, studentName } = parsed.data;
  const filters = [
    status ? eq(orders.status, status) : undefined,
    studentName ? sql`lower(${orders.studentName}) like ${`%${studentName.toLowerCase()}%`}` : undefined,
  ].filter((f) => f !== undefined);
  const rows = db
    .select()
    .from(orders)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(orders.id))
    .all();
  return c.json({ orders: attachItems(rows) });
});

app.get("/orders/:id", (c) => {
  const id = parseId(c.req.param("id"));
  const order = id ? getOrder(id) : null;
  if (!order) return c.json({ error: "order not found", correlationId: c.get("correlationId") }, 404);
  return c.json({ order });
});

app.post("/orders", async (c) => {
  const correlationId = c.get("correlationId");
  const body = await c.req.json().catch(() => null);
  const parsed = createOrderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid request body", details: parsed.error.issues, correlationId }, 400);
  }
  const { studentName, notes, items } = parsed.data;

  const validation = await menuClient.validateItems(items, correlationId);
  if (!validation.ok) {
    if (validation.kind === "validation") {
      log("warn", "menu validation rejected order", { correlationId, errors: validation.errors });
      return c.json({ error: "invalid items", details: validation.errors, correlationId }, 400);
    }
    log("error", "menu-service unavailable", { correlationId, detail: validation.message });
    return c.json({ error: "menu-service unavailable", detail: validation.message, correlationId }, 503);
  }

  const now = new Date().toISOString();
  const orderId = db.transaction((tx) => {
    const inserted = tx
      .insert(orders)
      .values({
        // temporary unique code; replaced with the id-based code below
        orderCode: `TMP-${crypto.randomUUID()}`,
        studentName,
        status: "pending",
        totalCents: validation.totalCents,
        notes: notes || null,
        correlationId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: orders.id })
      .get();
    tx.update(orders)
      .set({ orderCode: `ORD-${String(inserted.id).padStart(4, "0")}` })
      .where(eq(orders.id, inserted.id))
      .run();
    tx.insert(orderItems)
      .values(
        validation.items.map((it) => ({
          orderId: inserted.id,
          menuItemId: it.menuItemId,
          itemName: it.name,
          unitPriceCents: it.unitPriceCents,
          quantity: it.quantity,
          lineTotalCents: it.lineTotalCents,
        })),
      )
      .run();
    return inserted.id;
  });

  const order = getOrder(orderId)!;
  log("info", "order created", { correlationId, orderId, orderCode: order.orderCode, totalCents: order.totalCents });
  const eventPublished = await emit("order.created", order, correlationId);
  return c.json({ order, eventPublished, correlationId }, 201);
});

app.patch("/orders/:id/status", async (c) => {
  const correlationId = c.get("correlationId");
  const id = parseId(c.req.param("id"));
  const existing = id ? getOrder(id) : null;
  if (!existing) return c.json({ error: "order not found", correlationId }, 404);

  const parsed = updateStatusSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid request body", details: parsed.error.issues, correlationId }, 400);
  }
  const next = parsed.data.status;
  const previousStatus = existing.status;
  if (!ALLOWED_TRANSITIONS[previousStatus].includes(next)) {
    return c.json(
      {
        error: `invalid status transition: ${previousStatus} -> ${next}`,
        allowed: ALLOWED_TRANSITIONS[previousStatus],
        correlationId,
      },
      409,
    );
  }

  db.update(orders).set({ status: next, updatedAt: new Date().toISOString() }).where(eq(orders.id, existing.id)).run();
  const order = getOrder(existing.id)!;
  log("info", "order status updated", { correlationId, orderId: order.id, previousStatus, status: next });
  const eventPublished = await emit("order.status_updated", order, correlationId, previousStatus);
  return c.json({ order, eventPublished, correlationId });
});

app.notFound((c) => c.json({ error: "not found", correlationId: c.get("correlationId") }, 404));

app.onError((err, c) => {
  log("error", "unhandled error", { error: err.message, correlationId: c.get("correlationId") });
  return c.json({ error: "internal server error", correlationId: c.get("correlationId") }, 500);
});

startBroker();

const server = Bun.serve({ port: PORT, fetch: app.fetch });
log("info", "orders-service listening", { port: server.port, dbPath });

async function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  server.stop();
  await stopBroker();
  sqlite.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
