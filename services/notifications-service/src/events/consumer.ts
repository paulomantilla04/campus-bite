import amqp from "amqplib";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { z } from "zod";
import { db } from "../db";
import { notifications, type Notification } from "../db/schema";
import { sseHub } from "../realtime/sseHub";
import { log } from "../logger";

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "amqp://guest:guest@localhost:5672";
export const EXCHANGE = "cafeteria.events";
export const QUEUE = "notifications.orders.v2";
export const DLX_EXCHANGE = "cafeteria.dlx";
export const DLQ_QUEUE = "notifications.orders.dlq";
const DLQ_ROUTING_KEY = "dead-letter";
// Pre-DLX queue; its arguments can't be changed in place, so it is replaced by QUEUE.
const LEGACY_QUEUE = "notifications.orders";
const BINDING_PATTERN = "order.#";
const MIN_PAUSE_SECONDS = 5;
const MAX_PAUSE_SECONDS = 30;
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
  deadLetteredCount: 0,
  lastMessageAt: null as string | null,
};

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let backoffMs = MIN_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let activeConsumerTag: string | null = null;
let consumeInFlight = false;

const chaos = {
  paused: false,
  expiresAt: null as number | null,
};
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

export function getConsumerStats() {
  return {
    type: "rabbitmq" as const,
    status: stats.status,
    exchange: EXCHANGE,
    queue: QUEUE,
    deadLetterExchange: DLX_EXCHANGE,
    consuming: activeConsumerTag !== null,
    consumedCount: stats.consumedCount,
    duplicateCount: stats.duplicateCount,
    deadLetteredCount: stats.deadLetteredCount,
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
    // Malformed messages are never retryable: nack without requeue routes them to the DLQ.
    stats.deadLetteredCount++;
    log("warn", "consumer.message_dead_lettered", {
      routingKey: msg.fields.routingKey,
      dlq: DLQ_QUEUE,
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

/** Starts consuming QUEUE unless paused, already consuming, or disconnected. */
async function startConsuming(): Promise<void> {
  const ch = channel;
  if (!ch || chaos.paused || activeConsumerTag || consumeInFlight) return;
  consumeInFlight = true;
  try {
    const { consumerTag } = await ch.consume(QUEUE, (msg) => handleMessage(ch, msg), { noAck: false });
    if (channel !== ch) return;
    activeConsumerTag = consumerTag;
    log("info", "consumer.consuming", { queue: QUEUE, consumerTag });
    // A pause may have been requested while consume() was in flight.
    if (chaos.paused) await stopConsuming();
  } catch (err) {
    log("warn", "consumer.consume_failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    consumeInFlight = false;
  }
}

async function stopConsuming(): Promise<void> {
  const ch = channel;
  const tag = activeConsumerTag;
  activeConsumerTag = null;
  if (!ch || !tag) return;
  try {
    await ch.cancel(tag);
    log("info", "consumer.cancelled", { queue: QUEUE, consumerTag: tag });
  } catch (err) {
    log("warn", "consumer.cancel_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

export function getChaosState(): { paused: boolean; remainingSeconds: number } {
  const remainingMs = chaos.paused && chaos.expiresAt ? Math.max(0, chaos.expiresAt - Date.now()) : 0;
  return { paused: chaos.paused, remainingSeconds: Math.ceil(remainingMs / 1000) };
}

/** Pauses (cancels the consumer so messages stay queued) or resumes consumption. Pauses always auto-resume. */
export async function setConsumerPaused(paused: boolean, durationSeconds = 20): Promise<void> {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;

  if (paused) {
    const seconds = Math.min(MAX_PAUSE_SECONDS, Math.max(MIN_PAUSE_SECONDS, Math.round(durationSeconds)));
    chaos.paused = true;
    chaos.expiresAt = Date.now() + seconds * 1000;
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      log("info", "chaos.auto_resume");
      void setConsumerPaused(false);
    }, seconds * 1000);
    log("warn", "chaos.consumer_paused", { durationSeconds: seconds });
    await stopConsuming();
    return;
  }

  chaos.paused = false;
  chaos.expiresAt = null;
  log("info", "chaos.consumer_resumed");
  await startConsuming();
}

export async function inspectQueues(): Promise<{ pendingInQueue: number; dlqMessageCount: number }> {
  const ch = channel;
  if (!ch || stats.status !== "connected") return { pendingInQueue: 0, dlqMessageCount: 0 };
  try {
    const [main, dlq] = await Promise.all([ch.checkQueue(QUEUE), ch.checkQueue(DLQ_QUEUE)]);
    return { pendingInQueue: main.messageCount, dlqMessageCount: dlq.messageCount };
  } catch (err) {
    log("warn", "consumer.inspect_failed", { error: err instanceof Error ? err.message : String(err) });
    return { pendingInQueue: 0, dlqMessageCount: 0 };
  }
}

export type DlqTestResult =
  | {
      sent: true;
      dlqQueue: string;
      dlqMessageCount: number;
      pendingInQueue: number;
      consumerPaused: boolean;
      note: string;
    }
  | { sent: false; error: string };

/** Publishes a deliberately malformed order event that the consumer will dead-letter. */
export async function triggerDlqTest(): Promise<DlqTestResult> {
  const ch = channel;
  if (!ch || stats.status !== "connected") return { sent: false, error: "RabbitMQ disconnected" };
  const body = Buffer.from(JSON.stringify({ invalid: true, test: "dlq-chaos", ts: new Date().toISOString() }));
  ch.publish(EXCHANGE, "order.dlq_test", body, { persistent: true, contentType: "application/json" });

  const consumerPaused = chaos.paused;
  if (!consumerPaused) await new Promise((resolve) => setTimeout(resolve, 200));
  log("info", "chaos.dlq_test_published", { consumerPaused });
  return {
    sent: true,
    dlqQueue: DLQ_QUEUE,
    ...(await inspectQueues()),
    consumerPaused,
    note: consumerPaused
      ? `Consumer paused: message waits in ${QUEUE} and lands in ${DLQ_QUEUE} once resumed.`
      : `Consumer active: message was nacked into ${DLQ_QUEUE}.`,
  };
}

export async function purgeDlq(): Promise<{ purged: true; deletedCount: number } | { purged: false; error: string }> {
  const ch = channel;
  if (!ch || stats.status !== "connected") return { purged: false, error: "RabbitMQ disconnected" };
  try {
    const { messageCount } = await ch.purgeQueue(DLQ_QUEUE);
    log("info", "chaos.dlq_purged", { deletedCount: messageCount });
    return { purged: true, deletedCount: messageCount };
  } catch (err) {
    return { purged: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Best-effort removal of the pre-DLX queue on a throwaway channel, so failures never close the main channel. */
async function deleteLegacyQueue(conn: ChannelModel): Promise<void> {
  try {
    const tmp = await conn.createChannel();
    tmp.on("error", () => {});
    try {
      const { messageCount } = await tmp.deleteQueue(LEGACY_QUEUE);
      log("info", "consumer.legacy_queue_deleted", { queue: LEGACY_QUEUE, messageCount });
    } finally {
      await tmp.close().catch(() => {});
    }
  } catch {
    // Missing queue or insufficient permissions: nothing to clean up.
  }
}

function scheduleReconnect(): void {
  stats.status = "disconnected";
  connection = null;
  channel = null;
  activeConsumerTag = null;
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
    await ch.assertExchange(DLX_EXCHANGE, "direct", { durable: true });
    await ch.assertQueue(DLQ_QUEUE, { durable: true });
    await ch.bindQueue(DLQ_QUEUE, DLX_EXCHANGE, DLQ_ROUTING_KEY);
    await ch.assertExchange(EXCHANGE, "topic", { durable: true });
    await ch.assertQueue(QUEUE, {
      durable: true,
      arguments: { "x-dead-letter-exchange": DLX_EXCHANGE, "x-dead-letter-routing-key": DLQ_ROUTING_KEY },
    });
    await ch.bindQueue(QUEUE, EXCHANGE, BINDING_PATTERN);
    await ch.prefetch(10);
    await deleteLegacyQueue(conn);
    channel = ch;
    activeConsumerTag = null;

    stats.status = "connected";
    backoffMs = MIN_BACKOFF_MS;
    log("info", "consumer.connected", {
      exchange: EXCHANGE,
      queue: QUEUE,
      dlq: DLQ_QUEUE,
      pattern: BINDING_PATTERN,
      paused: chaos.paused,
    });
    // While a chaos pause is active, topology is ready but consumption waits for resume.
    await startConsuming();
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
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  const conn = connection;
  connection = null;
  channel = null;
  activeConsumerTag = null;
  stats.status = "disconnected";
  if (conn) await conn.close().catch(() => {});
}
