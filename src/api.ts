import type {
  Category,
  CreateOrderInput,
  EventsStatsResponse,
  MenuItem,
  NewMenuItemInput,
  NotificationItem,
  Order,
  OrderStatus,
  ServiceHealthPayload,
  ServiceProbeResult,
} from './types'

export class ApiRequestError extends Error {
  status: number
  details?: unknown
  correlationId?: string

  constructor(message: string, status: number, details?: unknown, correlationId?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.details = details
    this.correlationId = correlationId
  }
}

export function generateCorrelationId(): string {
  return `corr-${crypto.randomUUID().slice(0, 8)}`
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('X-Correlation-Id')) {
    headers.set('X-Correlation-Id', generateCorrelationId())
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let res: Response
  try {
    res = await fetch(url, { ...init, headers })
  } catch {
    throw new ApiRequestError('No se pudo conectar con el servidor', 503)
  }

  const corrId = res.headers.get('X-Correlation-Id') ?? headers.get('X-Correlation-Id') ?? undefined
  const data = await res.json().catch(() => null)

  if (!res.ok) {
    const msg =
      (data && (data.detail || data.message || data.error)) ||
      `Error HTTP ${res.status}`
    throw new ApiRequestError(String(msg), res.status, data?.details ?? data?.errors, corrId)
  }

  return data as T
}

// --- menu-service ---

export async function fetchMenuItems(params?: {
  category?: Category
  available?: boolean
  search?: string
}): Promise<MenuItem[]> {
  const qs = new URLSearchParams()
  if (params?.category) qs.set('category', params.category)
  if (params?.available !== undefined) qs.set('available', String(params.available))
  if (params?.search) qs.set('search', params.search)
  const query = qs.toString() ? `?${qs.toString()}` : ''
  const data = await request<{ items: MenuItem[] }>(`/api/menu/items${query}`)
  return data.items
}

export async function createMenuItem(input: NewMenuItemInput): Promise<MenuItem> {
  const data = await request<{ item: MenuItem }>('/api/menu/items', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return data.item
}

export async function updateMenuItem(
  id: number,
  patch: Partial<NewMenuItemInput>,
): Promise<MenuItem> {
  const data = await request<{ item: MenuItem }>(`/api/menu/items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return data.item
}

export async function deleteMenuItem(id: number): Promise<void> {
  await request<{ deleted: boolean; id: number }>(`/api/menu/items/${id}`, {
    method: 'DELETE',
  })
}

// --- orders-service ---

export async function fetchOrders(params?: {
  status?: OrderStatus
  studentName?: string
}): Promise<Order[]> {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.studentName) qs.set('studentName', params.studentName)
  const query = qs.toString() ? `?${qs.toString()}` : ''
  const data = await request<{ orders: Order[] }>(`/api/orders/orders${query}`)
  return data.orders
}

export async function createOrder(
  input: CreateOrderInput,
): Promise<{ order: Order; eventPublished: boolean; correlationId: string }> {
  return request<{ order: Order; eventPublished: boolean; correlationId: string }>(
    '/api/orders/orders',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  )
}

export async function updateOrderStatus(
  id: number,
  status: OrderStatus,
): Promise<{ order: Order; eventPublished: boolean; correlationId: string }> {
  return request<{ order: Order; eventPublished: boolean; correlationId: string }>(
    `/api/orders/orders/${id}/status`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    },
  )
}

// --- notifications-service ---

export async function fetchNotifications(params?: {
  studentName?: string
  unreadOnly?: boolean
  correlationId?: string
  limit?: number
}): Promise<{ notifications: NotificationItem[]; unreadCount: number }> {
  const qs = new URLSearchParams()
  if (params?.studentName) qs.set('studentName', params.studentName)
  if (params?.unreadOnly) qs.set('unreadOnly', 'true')
  if (params?.correlationId) qs.set('correlationId', params.correlationId)
  if (params?.limit) qs.set('limit', String(params.limit))
  const query = qs.toString() ? `?${qs.toString()}` : ''
  return request<{ notifications: NotificationItem[]; unreadCount: number }>(
    `/api/notifications/notifications${query}`,
  )
}

export async function markNotificationRead(id: number): Promise<NotificationItem> {
  const data = await request<{ notification: NotificationItem }>(
    `/api/notifications/notifications/${id}/read`,
    { method: 'PATCH' },
  )
  return data.notification
}

export async function markAllNotificationsRead(studentName?: string): Promise<number> {
  const qs = studentName ? `?studentName=${encodeURIComponent(studentName)}` : ''
  const data = await request<{ updatedCount: number }>(
    `/api/notifications/notifications/read-all${qs}`,
    { method: 'PATCH' },
  )
  return data.updatedCount
}

export async function fetchEventsStats(): Promise<EventsStatsResponse> {
  return request<EventsStatsResponse>('/api/notifications/events/stats')
}

export function openNotificationStream(studentName?: string): EventSource {
  const qs = studentName ? `?studentName=${encodeURIComponent(studentName)}` : ''
  return new EventSource(`/api/notifications/stream${qs}`)
}

// --- Health probes for Microservices Lab ---

async function probeOne(
  key: 'menu' | 'orders' | 'notifications',
  name: string,
  subtitle: string,
  url: string,
): Promise<ServiceProbeResult> {
  const started = performance.now()
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'X-Correlation-Id': generateCorrelationId() },
    })
    const latencyMs = Math.max(1, Math.round(performance.now() - started))
    const payload = (await res.json().catch(() => null)) as ServiceHealthPayload | null
    if (!res.ok || !payload || !payload.service) {
      return {
        key,
        name,
        subtitle,
        status: 'offline',
        latencyMs: null,
        payload: null,
        error: `HTTP ${res.status}`,
      }
    }
    return {
      key,
      name,
      subtitle,
      status: payload.status === 'healthy' ? 'healthy' : 'degraded',
      latencyMs,
      payload,
    }
  } catch (err) {
    return {
      key,
      name,
      subtitle,
      status: 'offline',
      latencyMs: null,
      payload: null,
      error: err instanceof Error ? err.message : 'Sin respuesta',
    }
  }
}

export async function probeAllServices(): Promise<ServiceProbeResult[]> {
  return Promise.all([
    probeOne('menu', 'menu-service', 'Hono + Bun · menu.db', '/api/menu/health'),
    probeOne('orders', 'orders-service', 'Hono + Bun · orders.db', '/api/orders/health'),
    probeOne(
      'notifications',
      'notifications-service',
      'Hono + Bun · notifications.db',
      '/api/notifications/health',
    ),
  ])
}
