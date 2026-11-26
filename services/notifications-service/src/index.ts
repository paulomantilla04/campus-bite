import { basename } from "node:path";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { db, dbPath } from "./db";
import { notifications } from "./db/schema";
import { getConsumerStats, isConsumerConnected, startConsumer, stopConsumer } from "./events/consumer";
import { log } from "./logger";
import { serializeNotification, sseHub } from "./realtime/sseHub";

const PORT = Number(process.env.PORT ?? 3003);
const SERVICE_NAME = "notifications-service";
const HEARTBEAT_MS = 20_000;
const startedAt = Date.now();

type AppEnv = { Variables: { correlationId: string } };

const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Correlation-Id"],
    exposeHeaders: ["X-Correlation-Id"],
  }),
);

app.use("*", async (c, next) => {
  const correlationId = c.req.header("X-Correlation-Id") || crypto.randomUUID();
  c.set("correlationId", correlationId);
  c.header("X-Correlation-Id", correlationId);
  const start = performance.now();
  await next();
  log("info", "http.request", {
    correlationId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Math.round(performance.now() - start),
  });
});

const boolParam = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const listQuerySchema = z.object({
  studentName: z.string().trim().min(1).optional(),
  unreadOnly: boolParam,
  correlationId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const studentQuerySchema = z.object({
  studentName: z.string().trim().min(1).optional(),
});

function countNotifications(where?: SQL): number {
  return db.select({ value: count() }).from(notifications).where(where).get()?.value ?? 0;
}

app.get("/health", (c) => {
  const connected = isConsumerConnected();
  return c.json({
    service: SERVICE_NAME,
    status: connected ? "healthy" : "degraded",
    database: {
      engine: "sqlite",
      file: basename(dbPath),
      status: "ok",
      notificationCount: countNotifications(),
    },
    broker: getConsumerStats(),
    sseClients: sseHub.getClientCount(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

app.get("/notifications", (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", details: z.flattenError(parsed.error) }, 400);
  }
  const { studentName, unreadOnly, correlationId, limit } = parsed.data;

  const scope: SQL[] = [];
  if (studentName) scope.push(eq(notifications.studentName, studentName));
  if (correlationId) scope.push(eq(notifications.correlationId, correlationId));

  const filters = [...scope];
  if (unreadOnly) filters.push(eq(notifications.read, false));

  const rows = db
    .select()
    .from(notifications)
    .where(and(...filters))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit)
    .all();

  const unreadCount = countNotifications(and(...scope, eq(notifications.read, false)));

  return c.json({ notifications: rows.map(serializeNotification), unreadCount });
});

app.patch("/notifications/read-all", (c) => {
  const parsed = studentQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", details: z.flattenError(parsed.error) }, 400);
  }
  const { studentName } = parsed.data;
  const where = and(
    eq(notifications.read, false),
    studentName ? eq(notifications.studentName, studentName) : undefined,
  );
  const updated = db.update(notifications).set({ read: true }).where(where).returning({ id: notifications.id }).all();
  return c.json({ updatedCount: updated.length });
});

app.patch("/notifications/:id/read", (c) => {
  const id = z.coerce.number().int().positive().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Invalid notification id" }, 400);

  const updated = db
    .update(notifications)
    .set({ read: true })
    .where(eq(notifications.id, id.data))
    .returning()
    .get();
  if (!updated) return c.json({ error: "Notification not found" }, 404);
  return c.json({ notification: serializeNotification(updated) });
});

// Applied after the handler because streamSSE overwrites Cache-Control with plain "no-cache".
app.use("/notifications/stream", async (c, next) => {
  await next();
  c.res.headers.set("X-Accel-Buffering", "no");
  c.res.headers.set("Cache-Control", "no-cache, no-transform");
});

app.get("/notifications/stream", (c) => {
  const studentName = c.req.query("studentName")?.trim() || undefined;
  const correlationId = c.get("correlationId");

  return streamSSE(c, async (stream) => {
    const clientId = crypto.randomUUID();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));

    const unsubscribe = sseHub.subscribe({
      id: clientId,
      studentName,
      send: (event, data) => stream.writeSSE({ event, data }),
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      log("info", "sse.client_disconnected", { clientId, studentName, sseClients: sseHub.getClientCount() });
      resolveDone();
    };

    stream.onAbort(cleanup);

    log("info", "sse.client_connected", { clientId, studentName, correlationId, sseClients: sseHub.getClientCount() });

    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({
        clientId,
        studentName: studentName ?? null,
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
      }),
    });

    heartbeat = setInterval(() => {
      stream.write(": ping\n\n").catch(cleanup);
    }, HEARTBEAT_MS);

    await done;
  });
});

app.get("/events/stats", (c) => {
  const rows = db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(30)
    .all();

  const recentEvents = rows.map((n) => {
    const { payload } = serializeNotification(n);
    return {
      id: n.id,
      eventId: n.eventId,
      eventType: n.eventType,
      routingKey: n.routingKey,
      exchange: "cafeteria.events",
      queue: "notifications.orders",
      correlationId: n.correlationId,
      sourceService: n.sourceService,
      orderId: n.orderId,
      orderCode: n.orderCode,
      studentName: n.studentName,
      title: n.title,
      message: n.message,
      read: n.read,
      receivedAt: n.createdAt,
      payload,
      payloadJson: n.payloadJson,
    };
  });

  return c.json({ broker: getConsumerStats(), sseClients: sseHub.getClientCount(), recentEvents });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  log("error", "http.unhandled_error", { correlationId: c.get("correlationId"), error: err.message });
  return c.json({ error: "Internal server error" }, 500);
});

startConsumer();

const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
  // SSE connections must outlive Bun's default 10s idle timeout.
  idleTimeout: 0,
});

log("info", "server.started", { port: server.port, dbFile: basename(dbPath) });

async function shutdown(signal: string) {
  log("info", "server.shutdown", { signal });
  await stopConsumer();
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
