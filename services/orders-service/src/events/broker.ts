import amqp from "amqplib";
import type { ConfirmChannel } from "amqplib";
import type { OrderStatus } from "../db/schema";

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "amqp://guest:guest@localhost:5672";
export const EXCHANGE = "cafeteria.events";
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 2_000;

export type OrderEventType = "order.created" | "order.status_updated";

export interface OrderEvent {
  eventId: string;
  eventType: OrderEventType;
  routingKey: OrderEventType;
  correlationId: string;
  sourceService: "orders-service";
  occurredAt: string;
  payload: {
    orderId: number;
    orderCode: string;
    studentName: string;
    status: OrderStatus;
    previousStatus?: OrderStatus;
    totalCents: number;
    itemsSummary: string;
  };
}

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

let connection: AmqpConnection | null = null;
let channel: ConfirmChannel | null = null;
let connecting = false;
let stopped = false;
let backoffMs = MIN_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let publishedCount = 0;

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level, service: "orders-service", component: "broker", msg, ...extra }),
  );
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  log("warn", "rabbitmq reconnect scheduled", { delayMs: delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function handleDisconnect(reason: string) {
  if (!connection && !channel) return;
  log("warn", "rabbitmq disconnected", { reason });
  connection = null;
  channel = null;
  scheduleReconnect();
}

async function connect(): Promise<void> {
  if (connecting || connection || stopped) return;
  connecting = true;
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    conn.on("error", (err: Error) => log("error", "rabbitmq connection error", { error: err.message }));
    conn.on("close", () => handleDisconnect("connection closed"));

    const ch = await conn.createConfirmChannel();
    ch.on("error", (err: Error) => log("error", "rabbitmq channel error", { error: err.message }));
    ch.on("close", () => {
      if (connection === conn) {
        channel = null;
        conn.close().catch(() => {});
      }
    });
    await ch.assertExchange(EXCHANGE, "topic", { durable: true });

    connection = conn;
    channel = ch;
    backoffMs = MIN_BACKOFF_MS;
    log("info", "rabbitmq connected", { exchange: EXCHANGE });
  } catch (err) {
    log("warn", "rabbitmq connection failed", { error: err instanceof Error ? err.message : String(err) });
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

export function startBroker() {
  stopped = false;
  void connect();
}

export async function stopBroker() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const conn = connection;
  connection = null;
  channel = null;
  await conn?.close().catch(() => {});
}

export function isBrokerConnected() {
  return channel !== null;
}

/** Publishes an event; resolves to true once the broker confirms, false if offline or it fails. Never throws. */
export async function publishEvent(event: OrderEvent): Promise<boolean> {
  const ch = channel;
  if (!ch) {
    log("warn", "event not published: broker offline", { eventType: event.eventType, correlationId: event.correlationId });
    return false;
  }
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        ch.publish(
          EXCHANGE,
          event.routingKey,
          Buffer.from(JSON.stringify(event)),
          {
            persistent: true,
            contentType: "application/json",
            messageId: event.eventId,
            headers: { "x-correlation-id": event.correlationId },
          },
          (err) => (err ? reject(err) : resolve()),
        );
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("publish confirm timeout")), PUBLISH_TIMEOUT_MS),
      ),
    ]);
    publishedCount++;
    log("info", "event published", {
      eventType: event.eventType,
      eventId: event.eventId,
      correlationId: event.correlationId,
    });
    return true;
  } catch (err) {
    log("error", "event publish failed", {
      eventType: event.eventType,
      correlationId: event.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function getBrokerStatus() {
  return {
    type: "rabbitmq" as const,
    status: isBrokerConnected() ? ("connected" as const) : ("disconnected" as const),
    exchange: EXCHANGE,
    publishedCount,
  };
}
