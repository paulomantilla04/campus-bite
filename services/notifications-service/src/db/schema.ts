import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type NotificationEventType = "order.created" | "order.status_updated";

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Idempotency key: redelivered RabbitMQ messages never create duplicates.
  eventId: text("event_id").notNull().unique(),
  orderId: integer("order_id").notNull(),
  orderCode: text("order_code").notNull(),
  studentName: text("student_name").notNull(),
  eventType: text("event_type").$type<NotificationEventType>().notNull(),
  routingKey: text("routing_key").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  payloadJson: text("payload_json").notNull(),
  correlationId: text("correlation_id").notNull(),
  sourceService: text("source_service").notNull(),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
