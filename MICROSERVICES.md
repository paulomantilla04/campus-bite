# CampusBite · Microservicios

```
Navegador ──► gateway (Nginx :80)  ──►  /            React (dist/)
                  │                ──►  /api/menu/*          menu-service          :3001  (SQLite)
                  │                ──►  /api/orders/*        orders-service        :3002  (SQLite) ──HTTP──► menu-service
                  │                ──►  /api/notifications/* notifications-service :3003  (SQLite)
                  │                                                 ▲
                  └── X-Correlation-Id      orders-service ──► RabbitMQ (order.*) ──┘
```

- El gateway **quita el prefijo**: `/api/menu/items?category=Drinks` → `menu-service` recibe `/items?category=Drinks`.
- Excepción: `/api/notifications/stream` → `notifications-service:/notifications/stream` (SSE, sin buffering).
- `GET /api/health` lo responde el propio gateway: `{"service":"api-gateway","status":"healthy"}`.
- Si un servicio está caído, el gateway responde `503` JSON: `{"error":"service_unavailable",...}`. La UI y `/api/health` siguen funcionando.
- **Rate limit** solo en escrituras (`POST`/`PATCH`/`DELETE` en `/api/menu/`, `/api/orders/`, `/api/notifications/`): `30r/m` por IP, `burst=15` (`nodelay`). Al excederlo → `429` JSON `{"error":"rate_limited","message":...,"correlationId"}`. `GET`/`OPTIONS`, el SSE y `/api/health` no se limitan.
- `/images/*.webp` (fotos de platillos en `public/images/`) se sirven con `Cache-Control: public, max-age=604800, immutable` (7 días).
- Toda respuesta lleva `X-Correlation-Id` (el que mandes tú o uno generado `corr-<request_id>`).
- El frontend usa **siempre** rutas relativas `/api/...`: en `bun run dev` las resuelve el proxy de Vite (`vite.config.ts`) y en Docker/Dokploy el gateway Nginx.

---

## 1. Contrato de la API

> Precios siempre en **centavos MXN** (`priceCents: 5000` = `$50.00 MXN`). Fechas en ISO 8601.
> Rutas comprobadas contra `services/*/src/index.ts`; ante cualquier duda, ese código manda.

### menu-service — `/api/menu`

| Método | Ruta | Body / query | Respuesta |
|---|---|---|---|
| GET | `/api/menu/health` | – | `{ service, status, database, uptimeSeconds, timestamp }` (503 si la BD falla) |
| GET | `/api/menu/items` | `?category=Desayunos\|Bebidas\|Panadería&available=true\|false&search=texto` | `{ items: MenuItem[] }` |
| GET | `/api/menu/items/:id` | – | `{ item: MenuItem }` · 404 `{ error }` |
| POST | `/api/menu/items` | `NewMenuItemInput` | 201 `{ item }` · 400 `{ error, details }` |
| PATCH | `/api/menu/items/:id` | `Partial<NewMenuItemInput>` (p. ej. `{ "available": false }`) | `{ item }` |
| DELETE | `/api/menu/items/:id` | – | `{ deleted: true, id }` |
| POST | `/api/menu/items/validate` | `{ items: [{ menuItemId, quantity }] }` | `{ valid: true, items: ValidatedLine[], totalCents }` · 400 `{ valid: false, errors }` (lo usa `orders-service`) |
| GET | `/api/menu/chaos` | – | `{ chaos: { mode, delayMs, remainingSeconds } }` |
| POST | `/api/menu/chaos` | `{ mode: "normal"\|"slow"\|"offline", delayMs?, durationSeconds? }` | `{ chaos }` · afecta a `/items/*`; vuelve solo a `normal` (máx. 30 s) |

### orders-service — `/api/orders`

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| GET | `/api/orders/health` | – | `{ service, status: "healthy"\|"degraded", database, ... }` (degraded = sin RabbitMQ) |
| GET | `/api/orders/orders` | `?status=&studentName=` | `{ orders: Order[] }` |
| GET | `/api/orders/orders/:id` | – | `{ order: Order }` |
| POST | `/api/orders/orders` | `CreateOrderInput` | 201 `{ order, eventPublished, correlationId }` · 400 ítems inválidos/no disponibles · **503 si `menu-service` no responde** (timeout 3 s) |
| PATCH | `/api/orders/orders/:id/status` | `{ status: OrderStatus }` | 200 `{ order, eventPublished, correlationId }` · 409 transición inválida → publica `order.status_updated` |

Cada pedido creado publica `order.created` en RabbitMQ (exchange tópico, routing key `order.*`).

### notifications-service — `/api/notifications`

| Método | Ruta | Body / query | Respuesta |
|---|---|---|---|
| GET | `/api/notifications/health` | – | `{ service, status, ... }` |
| GET | `/api/notifications/notifications` | `?studentName=&unreadOnly=true&correlationId=&limit=50` (máx. 200) | `{ notifications: Notification[], unreadCount }` |
| PATCH | `/api/notifications/notifications/:id/read` | – | `{ notification }` |
| PATCH | `/api/notifications/notifications/read-all` | `?studentName=` | `{ updatedCount }` |
| GET | `/api/notifications/events/stats` | – | estadísticas del consumidor RabbitMQ / SSE |
| GET (SSE) | `/api/notifications/stream` | `?studentName=Ana` (opcional, filtra) | evento `notification` con `Notification` en `data` |
| GET | `/api/notifications/chaos` | – | `{ chaos, pendingInQueue, dlqMessageCount, dlqQueue }` |
| POST | `/api/notifications/chaos` | `{ paused: boolean, durationSeconds? }` | pausa el consumidor; se reanuda solo (máx. 30 s) |
| POST | `/api/notifications/chaos/dlq-test` | – | publica un mensaje inválido que acaba en la DLQ · 503 sin RabbitMQ |
| POST | `/api/notifications/chaos/dlq-purge` | – | vacía la DLQ · 503 sin RabbitMQ |

**Dead Letter Queue:** los mensajes rechazados de la cola principal `notifications.orders.v2` van al exchange `cafeteria.dlx` → cola `notifications.orders.dlq`.

### Higiene automática de la demo

Para que la demo pública no crezca sin control: máx. **50 pedidos** (se borran los más antiguos, y los `delivered`/`cancelled` de más de 24 h), **100 notificaciones** y **30 ítems de menú** (`POST /api/menu/items` devuelve 400 al llegar al límite).

### Tipos para `src/types.ts`

```ts
export type Category = 'Desayunos' | 'Bebidas' | 'Panadería'
export type OrderStatus = 'pending' | 'preparing' | 'ready' | 'delivered' | 'cancelled'
export type NotificationEventType = 'order.created' | 'order.status_updated'

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

export interface ValidatedLine {
  menuItemId: number
  name: string
  unitPriceCents: number
  quantity: number
  lineTotalCents: number
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

export interface Notification {
  id: number
  eventId: string
  orderId: number
  orderCode: string
  studentName: string
  eventType: NotificationEventType
  routingKey: string
  title: string
  message: string
  payload: unknown
  correlationId: string
  sourceService: string
  read: boolean
  createdAt: string
}

export interface ApiError {
  error: string
  message?: string
  details?: unknown
  correlationId?: string
}
```

### Snippets

```ts
// Crear pedido (con correlation id propio para rastrearlo)
const res = await fetch('/api/orders/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': `ui-${crypto.randomUUID()}` },
  body: JSON.stringify({ studentName: 'Ana', items: [{ menuItemId: 1, quantity: 2 }] } satisfies CreateOrderInput),
})
if (res.status === 503) alert('Cocina sin conexión, inténtalo en unos segundos')
const { order } = (await res.json()) as { order: Order }
```

```ts
// Notificaciones en tiempo real (React)
useEffect(() => {
  const es = new EventSource(`/api/notifications/stream?studentName=${encodeURIComponent(studentName)}`)
  es.addEventListener('notification', (e) => {
    const n = JSON.parse((e as MessageEvent).data) as Notification
    setNotifications((prev) => [n, ...prev])
  })
  es.onerror = () => console.warn('SSE desconectado, EventSource reintentará solo')
  return () => es.close()
}, [studentName])
```

---

## 2. Ejecutar en local

### Opción A — todo en Docker (recomendado)

```bash
cp .env.example .env          # opcional
docker compose up --build
```

- App + API: http://localhost:8080 (`GATEWAY_PORT`)
- RabbitMQ UI: http://localhost:15672 (`cafeteria` / `cafeteria`)
- Comprobar: `curl -i http://localhost:8080/api/health` y `curl http://localhost:8080/api/menu/items`

### Opción B — servicios Bun en local + Vite con HMR

```bash
docker compose up -d rabbitmq                       # solo el broker

# una terminal por servicio
cd services/menu-service          && bun install && PORT=3001 DB_PATH=./data/menu.db bun run dev
cd services/orders-service        && bun install && PORT=3002 DB_PATH=./data/orders.db \
  MENU_SERVICE_URL=http://localhost:3001 RABBITMQ_URL=amqp://cafeteria:cafeteria@localhost:5672 bun run dev
cd services/notifications-service && bun install && PORT=3003 DB_PATH=./data/notifications.db \
  RABBITMQ_URL=amqp://cafeteria:cafeteria@localhost:5672 bun run dev

# frontend
bun install && bun run dev                           # http://localhost:5173, /api/* -> proxy Vite
```

> En la opción B, el puerto AMQP `5672` no está publicado en `docker-compose.yml`; arranca el broker con
> `docker run -d --name rabbit -p 5672:5672 -p 15672:15672 -e RABBITMQ_DEFAULT_USER=cafeteria -e RABBITMQ_DEFAULT_PASS=cafeteria rabbitmq:3-management-alpine`
> (o añade `"5672:5672"` en un `docker-compose.override.yml`). `/api/health` solo existe en el gateway, no en el proxy de Vite.

---

## 3. Desplegar en Dokploy

1. **Project → Create Service → Compose**. Tipo `Docker Compose`.
2. **Provider**: tu repo Git, rama `main`, *Compose Path* `./docker-compose.yml`.
3. **Environment**: pega `.env.example` y cambia al menos `RABBITMQ_PASS` (y `RABBITMQ_USER`).
4. **Deploy**. Dokploy construye `gateway` (React + Nginx) y los tres servicios Bun; los volúmenes `*_data` persisten las BD SQLite y RabbitMQ entre despliegues.
5. **Domains → Add Domain**:
   - Host `campusbite.tudominio.com` → *Service* `gateway`, *Container Port* `80`, HTTPS con Let's Encrypt.
   - (Opcional) `rabbit.tudominio.com` → *Service* `rabbitmq`, *Container Port* `15672`. Usa una contraseña fuerte.
6. Con dominios en Traefik no necesitas los `ports:` publicados; si chocan con otros puertos del VPS, cambia `GATEWAY_PORT` / `RABBITMQ_UI_PORT` en *Environment*.
7. Verifica: `curl -i https://campusbite.tudominio.com/api/health`.

> No hay `container_name` fijo, así Dokploy puede recrear y nombrar contenedores sin conflictos. Los servicios se encuentran por nombre DNS dentro de `cafeteria-net`.

---

## 4. Experimentos de microservicios

### 🔕 1. Tumba `notifications-service` (mensajería asíncrona)

```bash
docker compose stop notifications-service
# crea un par de pedidos desde la UI o con curl → siguen funcionando (201)
open http://localhost:15672   # Queues: los mensajes order.* se acumulan
docker compose start notifications-service
```

**Qué observar:** los pedidos nunca fallan; al volver, el servicio consume la cola y emite todas las notificaciones pendientes (sin duplicados gracias a `eventId`). Mientras está caído, `/api/notifications/*` devuelve 503 JSON y el `EventSource` reintenta solo.

### 🍔 2. Tumba `menu-service` (dependencia síncrona)

```bash
docker compose stop menu-service
curl -i http://localhost:8080/api/menu/items          # 503 del gateway
curl -i -X POST http://localhost:8080/api/orders/orders \
  -H 'Content-Type: application/json' \
  -d '{"studentName":"Ana","items":[{"menuItemId":1,"quantity":1}]}'   # 503 de orders-service (no puede validar)
curl -i http://localhost:8080/api/orders/orders        # listar pedidos SÍ funciona
docker compose start menu-service
```

**Qué observar:** el fallo queda aislado; la UI carga, el historial de pedidos sigue disponible y `orders-service` responde rápido gracias a `MENU_TIMEOUT_MS=3000` en vez de colgarse.

### 🧵 3. Sigue un `X-Correlation-Id` por todo el sistema

```bash
curl -i -X POST http://localhost:8080/api/orders/orders \
  -H 'Content-Type: application/json' -H 'X-Correlation-Id: demo-42' \
  -d '{"studentName":"Ana","items":[{"menuItemId":1,"quantity":2}]}'

docker compose logs menu-service orders-service notifications-service | grep demo-42
```

**Qué observar:** el mismo id aparece en la respuesta, en el log de `menu-service` (validación HTTP), en `orders-service`, en el mensaje de RabbitMQ y en la notificación guardada (`correlationId`). Sin cabecera, el gateway genera `corr-<request_id>`.
