export const CATEGORIES = ['Desayunos', 'Bebidas', 'Panadería'] as const
export type Category = (typeof CATEGORIES)[number]

export type OrderStatus = 'pending' | 'preparing' | 'ready' | 'delivered' | 'cancelled'
export type NotificationEventType = 'order.created' | 'order.status_updated'
export type AppView = 'menu' | 'kitchen' | 'lab'

export interface MenuItem {
  id: number
  name: string
  description: string
  category: Category
  priceCents: number
  available: boolean
  prepMinutes: number
  emoji: string
  imageUrl: string | null
  createdAt: string
}

export interface NewMenuItemInput {
  name: string
  description: string
  category: Category
  priceCents: number
  available?: boolean
  prepMinutes?: number
  emoji?: string
  imageUrl?: string | null
}

export interface OrderItem {
  id: number
  orderId: number
  menuItemId: number
  itemName: string
  unitPriceCents: number
  quantity: number
  lineTotalCents: number
}

export interface Order {
  id: number
  orderCode: string
  studentName: string
  status: OrderStatus
  totalCents: number
  notes: string | null
  correlationId: string
  createdAt: string
  updatedAt: string
  items: OrderItem[]
}

export interface CreateOrderInput {
  studentName: string
  notes?: string
  items: { menuItemId: number; quantity: number }[]
}

export interface NotificationItem {
  id: number
  eventId: string
  orderId: number
  orderCode: string
  studentName: string
  eventType: NotificationEventType
  routingKey: string
  title: string
  message: string
  payload: Record<string, unknown>
  payloadJson?: string
  correlationId: string
  sourceService: string
  read: boolean
  createdAt: string
}

export interface BrokerStats {
  type: 'rabbitmq'
  status: 'connected' | 'disconnected'
  exchange: string
  queue?: string
  publishedCount?: number
  consumedCount?: number
  duplicateCount?: number
  lastMessageAt?: string | null
}

export interface ServiceHealthPayload {
  service: string
  status: 'healthy' | 'degraded' | 'unhealthy'
  database?: {
    engine: string
    file: string
    status: string
    itemCount?: number
    orderCount?: number
    notificationCount?: number
  }
  broker?: BrokerStats
  sseClients?: number
  uptimeSeconds?: number
  timestamp?: string
}

export interface ServiceProbeResult {
  key: 'menu' | 'orders' | 'notifications'
  name: string
  subtitle: string
  status: 'healthy' | 'degraded' | 'offline'
  latencyMs: number | null
  payload: ServiceHealthPayload | null
  error?: string
}

export interface EventStreamItem {
  id: number
  eventId: string
  eventType: NotificationEventType
  routingKey: string
  exchange: string
  queue: string
  correlationId: string
  sourceService: string
  orderId: number
  orderCode: string
  studentName: string
  title: string
  message: string
  read: boolean
  receivedAt: string
  payload: Record<string, unknown>
  payloadJson: string
}

export interface EventsStatsResponse {
  broker: BrokerStats
  sseClients: number
  recentEvents: EventStreamItem[]
}

export function formatMXN(cents: number): string {
  const value = cents / 100
  return Number.isInteger(value) ? `$${value} MXN` : `$${value.toFixed(2)} MXN`
}

export function formatShortPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (diffSec < 60) return 'AHORA'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `HACE ${mins}M`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `HACE ${hrs}H`
  return new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }).toUpperCase()
}

export function formatClockTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}
