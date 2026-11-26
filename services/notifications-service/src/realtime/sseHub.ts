import type { Notification } from "../db/schema";

export interface SseSubscriber {
  id: string;
  studentName?: string;
  send: (event: string, data: string) => Promise<void>;
}

class SseHub {
  private subscribers = new Map<string, SseSubscriber>();

  subscribe(subscriber: SseSubscriber): () => void {
    this.subscribers.set(subscriber.id, subscriber);
    return () => this.unsubscribe(subscriber.id);
  }

  unsubscribe(id: string): void {
    this.subscribers.delete(id);
  }

  get activeSubscribers(): number {
    return this.subscribers.size;
  }

  getClientCount(): number {
    return this.subscribers.size;
  }

  broadcast(notification: Notification): number {
    const data = JSON.stringify(serializeNotification(notification));
    let delivered = 0;
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.studentName && subscriber.studentName !== notification.studentName) continue;
      delivered++;
      subscriber.send("notification", data).catch(() => this.unsubscribe(subscriber.id));
    }
    return delivered;
  }
}

export function serializeNotification(notification: Notification) {
  let payload: unknown;
  try {
    payload = JSON.parse(notification.payloadJson);
  } catch {
    payload = null;
  }
  return { ...notification, payload };
}

export const sseHub = new SseHub();
