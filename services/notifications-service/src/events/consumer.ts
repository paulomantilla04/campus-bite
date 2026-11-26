import amqp from "amqplib";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { z } from "zod";
import { db } from "../db";
import { notifications, type Notification } from "../db/schema";
import { sseHub } from "../realtime/sseHub";
import { log } from "../logger";

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "amqp://guest:guest@localhost:5672";
const EXCHANGE = "cafeteria.events";
const QUEUE = "notifications.orders";
const BINDING_PATTERN = "order.#";
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;

const orderStatusSchema = z.enum(["pending", "preparing", "ready", "delivered", "cancelled"]);

const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(["order.created", "order.status_updated"]),
  routingKey: z.enum(["order.created", "order.status_updated"]),
  correlationId: z.string().min(1),
  sourceService: z.string().min(1),
  occurredAt: z.string().min(1),
  payload: z.object({
    orderId: z.number().int(),
    orderCode: z.string().min(1),
    studentName: z.string().min(1),
    status: orderStatusSchema,
    previousStatus: z.string().optional(),
    totalCents: z.number().int(),
    itemsSummary: z.string(),
  }),
});

export type OrderEventEnvelope = z.infer<typeof eventEnvelopeSchema>;

const stats = {
  status: "disconnected" as "connected" | "disconnected",
  consumedCount: 0,
  duplicateCount: 0,
  lastMessageAt: null as string | null,
};

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let backoffMs = MIN_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export function getConsumerStats() {
  return {
    type: "rabbitmq" as const,
    status: stats.status,
    exchange: EXCHANGE,
    queue: QUEUE,
    consumedCount: stats.consumedCount,
    duplicateCount: stats.duplicateCount,
    lastMessageAt: stats.lastMessageAt,
  };
}

export function isConsumerConnected(): boolean {
  return stats.status === "connected";
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)} MXN`;
}

export function buildNotificationText(event: OrderEventEnvelope): { title: string; message: string } {
  const { orderCode, studentName, status, totalCents, itemsSummary } = event.payload;

  if (event.eventType === "order.created") {
    return {
      title: `Pedido ${orderCode} recibido`,
      message: `Hola ${studentName}, recibimos tu pedido (${itemsSummary}) por ${formatCents(totalCents)}. Te avisaremos cuando cocina empiece a prepararlo.`,
    };
  }

  switch (status) {
    case "preparing":
      return {
        title: `Pedido ${orderCode} en preparación`,
        message: `¡Buenas noticias, ${studentName}! Cocina ya está preparando tu pedido (${itemsSummary}).`,
      };
    case "ready":
      return {
        title: `¡Pedido ${orderCode} listo para recoger!`,
        message: `${studentName}, tu pedido (${itemsSummary}) está listo. Pasa a barra y muestra el código ${orderCode}.`,
      };
    case "delivered":
      return {
        title: `Pedido ${orderCode} entregado`,
        message: `Tu pedido fue entregado. ¡Buen provecho, ${studentName}!`,
      };
    case "cancelled":
      return {
        title: `Pedido ${orderCode} cancelado`,
        message: `Lo sentimos ${studentName}, tu pedido (${itemsSummary}) fue cancelado.`,
      };
    case "pending":
      return {
        title: `Pedido ${orderCode} pendiente`,
        message: `${studentName}, tu pedido (${itemsSummary}) está en espera de ser aceptado por cocina.`,
      };
  }
}

/** Persists an event idempotently. Returns the notification if newly inserted, null if duplicate. */
export function persistEvent(event: OrderEventEnvelope): Notification | null {
  const { title, message } = buildNotificationText(event);
  const inserted = db
    .insert(notifications)
    .values({
      eventId: event.eventId,
      orderId: event.payload.orderId,
      orderCode: event.payload.orderCode,
      studentName: event.payload.studentName,
      eventType: event.eventType,
      routingKey: event.routingKey,
      title,
      message,
      payloadJson: JSON.stringify(event.payload),
      correlationId: event.correlationId,
      sourceService: event.sourceService,
      read: false,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: notifications.eventId })
    .returning()
    .all();
  return inserted[0] ?? null;
}

function handleMessage(ch: Channel, msg: ConsumeMessage | null): void {
  if (!msg) return; // consumer cancelled by broker

  let event: OrderEventEnvelope;
  try {
    const parsed = eventEnvelopeSchema.safeParse(JSON.parse(msg.content.toString("utf8")));
    if (!parsed.success) throw new Error(parsed.error.message);
    event = parsed.data;
  } catch (err) {
    log("warn", "consumer.message_rejected", {
      routingKey: msg.fields.routingKey,
      reason: err instanceof Error ? err.message : String(err),
    });
    ch.nack(msg, false, false);
    return;
  }

  try {
    const notification = persistEvent(event);
    stats.consumedCount++;
    stats.lastMessageAt = new Date().toISOString();

    if (notification) {
      const delivered = sseHub.broadcast(notification);
      log("info", "consumer.notification_created", {
        correlationId: event.correlationId,
        eventId: event.eventId,
        eventType: event.eventType,
        orderCode: event.payload.orderCode,
        sseDelivered: delivered,
      });
    } else {
      stats.duplicateCount++;
      log("info", "consumer.duplicate_ignored", {
        correlationId: event.correlationId,
        eventId: event.eventId,
      });
    }
    ch.ack(msg);
  } catch (err) {
    // Transient failure (e.g. DB locked): requeue for another attempt.
    log("error", "consumer.processing_failed", {
      correlationId: event.correlationId,
      eventId: event.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    ch.nack(msg, false, true);
  }
}

function scheduleReconnect(): void {
  stats.status = "disconnected";
  connection = null;
  channel = null;
  if (stopped || reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  log("warn", "consumer.reconnect_scheduled", { delayMs: delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (stopped) return;
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    conn.on("error", (err: Error) => log("error", "consumer.connection_error", { error: err.message }));
    conn.on("close", () => {
      if (connection === conn) {
        log("warn", "consumer.connection_closed");
        scheduleReconnect();
      }
    });
    connection = conn;

    const ch = await conn.createChannel();
    ch.on("error", (err: Error) => log("error", "consumer.channel_error", { error: err.message }));
    await ch.assertExchange(EXCHANGE, "topic", { durable: true });
    await ch.assertQueue(QUEUE, { durable: true });
    await ch.bindQueue(QUEUE, EXCHANGE, BINDING_PATTERN);
    await ch.prefetch(10);
    await ch.consume(QUEUE, (msg) => handleMessage(ch, msg), { noAck: false });
    channel = ch;

    stats.status = "connected";
    backoffMs = MIN_BACKOFF_MS;
    log("info", "consumer.connected", { exchange: EXCHANGE, queue: QUEUE, pattern: BINDING_PATTERN });
  } catch (err) {
    log("warn", "consumer.connect_failed", { error: err instanceof Error ? err.message : String(err) });
    const conn = connection;
    connection = null;
    if (conn) await conn.close().catch(() => {});
    scheduleReconnect();
  }
}

export function startConsumer(): void {
  stopped = false;
  void connect();
}

export async function stopConsumer(): Promise<void> {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const conn = connection;
  connection = null;
  channel = null;
  stats.status = "disconnected";
  if (conn) await conn.close().catch(() => {});
}
