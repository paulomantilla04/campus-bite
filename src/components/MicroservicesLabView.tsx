import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { fetchEventsStats, probeAllServices } from '../api'
import type {
  BrokerStats,
  EventStreamItem,
  EventsStatsResponse,
  NotificationItem,
  ServiceProbeResult,
} from '../types'
import { formatClockTime } from '../types'
import { EASE_EDITORIAL, SPRING_SNAPPY } from '../motion'
import { Skeleton } from './Skeleton'

export interface MicroservicesLabViewProps {
  sseConnected: boolean
  latestNotification: NotificationItem | null
}

type ServiceKey = ServiceProbeResult['key']
type ServiceStatus = ServiceProbeResult['status']

const REFRESH_INTERVAL_MS = 8000
const EXCHANGE_NAME = 'cafeteria.events'

const SERVICE_DEFAULTS: Record<ServiceKey, { name: string; subtitle: string }> = {
  menu: { name: 'menu-service', subtitle: 'Hono + Bun · menu.db' },
  orders: { name: 'orders-service', subtitle: 'Hono + Bun · orders.db' },
  notifications: { name: 'notifications-service', subtitle: 'Hono + Bun · notifications.db' },
}

const STATUS_LABEL: Record<ServiceStatus, string> = {
  healthy: 'HEALTHY',
  degraded: 'DEGRADED',
  offline: 'OFFLINE',
}

const STATUS_TEXT: Record<ServiceStatus, string> = {
  healthy: 'text-live-green',
  degraded: 'text-vermilion-cta',
  offline: 'text-offline-red',
}

const STATUS_DOT: Record<ServiceStatus, string> = {
  healthy: 'bg-live-green',
  degraded: 'bg-vermilion',
  offline: 'bg-offline-red',
}

const TOPOLOGY_BOX: Record<ServiceStatus, string> = {
  healthy: 'border-hairline text-espresso',
  degraded: 'border-vermilion text-vermilion-cta',
  offline: 'border-offline-red text-offline-red',
}

function serviceRoute(ev: EventStreamItem): string {
  const source = ev.sourceService.replace(/-service$/, '') || 'orders'
  return `${source} → notifications`
}

function ArrowIcon({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function PipelineArrow({ active, delay = 0 }: { active: boolean; delay?: number }) {
  return (
    <motion.span
      className="inline-flex"
      animate={active ? { x: [0, 3.5, 0], opacity: [0.55, 1, 0.55] } : { x: 0, opacity: 0.4 }}
      transition={
        active
          ? { duration: 1.5, delay, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.2 }
      }
    >
      <ArrowIcon className={`w-4 h-4 ${active ? 'text-vermilion-cta' : 'text-hairline'}`} />
    </motion.span>
  )
}

function FlowArrow() {
  return (
    <svg
      className="w-4 h-4 text-stone shrink-0 hidden sm:block"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function StatusLine({
  label,
  tone,
  dot,
  pulse = false,
}: {
  label: string
  tone: string
  dot: string
  pulse?: boolean
}) {
  return (
    <div className={`inline-flex items-center gap-2 font-mono text-xs uppercase ${tone}`}>
      <span className="relative flex w-1.5 h-1.5">
        {pulse && (
          <motion.span
            className={`absolute inline-flex h-full w-full rounded-full ${dot}`}
            animate={{ scale: [1, 2.2], opacity: [0.5, 0] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <span className={`relative w-1.5 h-1.5 rounded-full ${dot}`} />
      </span>
      <span>{label}</span>
    </div>
  )
}

function ServiceTileSkeleton() {
  return (
    <div className="p-6 flex flex-col justify-between gap-4">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3.5 w-40" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-3.5 w-12" />
        <Skeleton className="h-3.5 w-16" />
      </div>
    </div>
  )
}

function EventInspectorSkeleton() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <tr key={i}>
          <td className="py-3.5 px-5"><Skeleton className="h-3.5 w-16" /></td>
          <td className="py-3.5 px-4"><Skeleton className="h-3.5 w-32" /></td>
          <td className="py-3.5 px-4"><Skeleton className="h-3.5 w-20" /></td>
          <td className="py-3.5 px-4"><Skeleton className="h-3.5 w-24" /></td>
          <td className="py-3.5 px-4"><Skeleton className="h-3.5 w-36" /></td>
          <td className="py-3.5 px-4"><Skeleton className="h-3.5 w-10" /></td>
          <td className="py-3.5 px-5 text-right"><Skeleton className="h-3.5 w-10 ml-auto" /></td>
        </tr>
      ))}
    </>
  )
}

const tileVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.055, duration: 0.3, ease: EASE_EDITORIAL },
  }),
}

export function MicroservicesLabView({ sseConnected, latestNotification }: MicroservicesLabViewProps) {
  const [probes, setProbes] = useState<ServiceProbeResult[] | null>(null)
  const [stats, setStats] = useState<EventsStatsResponse | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const inFlight = useRef(false)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    const started = Date.now()
    try {
      const [probeResults, statsResult] = await Promise.all([
        probeAllServices().catch(() => null),
        fetchEventsStats().catch(() => null),
      ])
      const elapsed = Date.now() - started
      if (elapsed < 380) await new Promise((r) => setTimeout(r, 380 - elapsed))
      if (!mounted.current) return
      if (probeResults) setProbes(probeResults)
      setStats(statsResult)
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setRefreshing(false)
        setInitialLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, latestNotification])

  useEffect(() => {
    const id = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  const probeByKey = useMemo(() => {
    const map: Partial<Record<ServiceKey, ServiceProbeResult>> = {}
    for (const p of probes ?? []) map[p.key] = p
    return map
  }, [probes])

  const statusOf = (key: ServiceKey): ServiceStatus => probeByKey[key]?.status ?? 'offline'

  const broker: BrokerStats | null =
    probeByKey.orders?.payload?.broker ??
    probeByKey.notifications?.payload?.broker ??
    stats?.broker ??
    null
  const brokerConnected = broker?.status === 'connected'
  const notificationsOffline = probes !== null && statusOf('notifications') === 'offline'

  const sseClients = probeByKey.notifications?.payload?.sseClients ?? stats?.sseClients

  const events = useMemo(() => stats?.recentEvents ?? [], [stats])
  const filteredEvents = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return events
    return events.filter(
      (ev) =>
        ev.correlationId.toLowerCase().includes(q) ||
        ev.orderCode.toLowerCase().includes(q) ||
        ev.eventType.toLowerCase().includes(q),
    )
  }, [events, filter])

  const toggleExpanded = (eventId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(eventId)) next.delete(eventId)
      else next.add(eventId)
      return next
    })
  }

  const serviceMeta = (key: ServiceKey): string | null => {
    const p = probeByKey[key]
    if (!p?.payload) return null
    if (key === 'menu' && p.payload.database?.itemCount !== undefined)
      return `${p.payload.database.itemCount} ITEMS`
    if (key === 'orders' && p.payload.database?.orderCount !== undefined)
      return `${p.payload.database.orderCount} PEDIDOS`
    if (key === 'notifications' && sseClients !== undefined) return `${sseClients} SSE`
    return null
  }

  const brokerDetail = (() => {
    if (!broker) return 'SIN DATOS'
    const pub = broker.publishedCount
    const cons = broker.consumedCount
    if (pub !== undefined || cons !== undefined) return `PUB: ${pub ?? 0} · CONS: ${cons ?? 0}`
    if (broker.queue) return `QUEUE: ${broker.queue}`
    return 'SIN TRÁFICO'
  })()

  const serviceKeys: ServiceKey[] = ['menu', 'orders', 'notifications']

  return (
    <div className="flex-1 max-w-[1440px] w-full mx-auto px-6 sm:px-8 py-10 flex flex-col gap-10">
      {/* 1. Service status tiles */}
      <section className="flex flex-col gap-4" aria-labelledby="service-health-title">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: EASE_EDITORIAL }}
          className="flex items-end justify-between gap-4"
        >
          <h1
            id="service-health-title"
            className="font-display font-bold text-3xl tracking-tight text-espresso"
          >
            Lab de Microservicios
          </h1>
          <motion.button
            type="button"
            whileTap={{ scale: 0.97 }}
            transition={SPRING_SNAPPY}
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-card bg-receipt border border-hairline hover:border-espresso font-display font-semibold text-xs tracking-tight text-espresso transition-colors disabled:opacity-70"
          >
            <motion.svg
              className="w-3.5 h-3.5 text-stone"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
              transition={
                refreshing ? { duration: 0.75, repeat: Infinity, ease: 'linear' } : { duration: 0.2 }
              }
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </motion.svg>
            <span>{refreshing ? 'Actualizando…' : 'Actualizar'}</span>
          </motion.button>
        </motion.div>

        <div className="bg-receipt border border-hairline rounded-card grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-hairline">
          {probes === null ? (
            <>
              <ServiceTileSkeleton />
              <ServiceTileSkeleton />
              <ServiceTileSkeleton />
              <ServiceTileSkeleton />
            </>
          ) : (
            <>
              {serviceKeys.map((key, i) => {
                const probe = probeByKey[key]
                const status = statusOf(key)
                const meta = serviceMeta(key)
                return (
                  <motion.div
                    key={key}
                    custom={i}
                    variants={tileVariants}
                    initial="hidden"
                    animate="visible"
                    className="p-6 flex flex-col justify-between gap-4"
                  >
                    <div className="flex flex-col gap-1.5">
                      <StatusLine
                        label={STATUS_LABEL[status]}
                        tone={STATUS_TEXT[status]}
                        dot={STATUS_DOT[status]}
                        pulse={status === 'healthy'}
                      />
                      <h2 className="font-mono font-semibold text-sm text-espresso">
                        {probe?.name ?? SERVICE_DEFAULTS[key].name}
                      </h2>
                      <p className="font-body text-sm text-stone">
                        {probe?.subtitle ?? SERVICE_DEFAULTS[key].subtitle}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-3 font-mono text-xs uppercase tabular-nums">
                      {probe?.latencyMs != null ? (
                        <motion.span
                          key={probe.latencyMs}
                          initial={{ opacity: 0.45 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.25 }}
                          className="text-espresso"
                        >
                          {probe.latencyMs}MS
                        </motion.span>
                      ) : (
                        <span className="text-offline-red">TIMEOUT</span>
                      )}
                      {meta && <span className="text-stone">{meta}</span>}
                    </div>
                  </motion.div>
                )
              })}

              <motion.div
                custom={3}
                variants={tileVariants}
                initial="hidden"
                animate="visible"
                className="p-6 flex flex-col justify-between gap-4"
              >
                <div className="flex flex-col gap-1.5">
                  {brokerConnected ? (
                    <StatusLine label="CONNECTED" tone="text-live-green" dot="bg-live-green" pulse />
                  ) : (
                    <StatusLine label="DISCONNECTED" tone="text-offline-red" dot="bg-offline-red" />
                  )}
                  <h2 className="font-display font-semibold text-sm tracking-tight text-espresso">
                    RabbitMQ Broker
                  </h2>
                  <p className="font-body text-sm text-stone">
                    exchange: {broker?.exchange ?? EXCHANGE_NAME}
                  </p>
                </div>
                <span className="font-mono text-xs uppercase text-stone tabular-nums">{brokerDetail}</span>
              </motion.div>
            </>
          )}
        </div>
      </section>

      {/* 2. System topology */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.08, ease: EASE_EDITORIAL }}
        className="bg-receipt border border-hairline rounded-card p-6 flex flex-col gap-6"
        aria-labelledby="arch-title"
      >
        <div className="flex items-baseline justify-between border-b border-hairline pb-3">
          <h2 id="arch-title" className="font-display font-bold text-lg tracking-tight text-espresso">
            Topología del Sistema
          </h2>
          <span className="font-mono text-xs uppercase text-stone">GATEWAY + BUS DE EVENTOS</span>
        </div>

        <div className="flex flex-wrap lg:flex-nowrap items-center gap-4">
          <div className="px-4 py-2.5 rounded-card border border-hairline bg-paper font-display font-semibold text-xs text-espresso shrink-0">
            React Web
          </div>
          <FlowArrow />
          <div className="px-4 py-2.5 rounded-card border border-hairline bg-paper font-display font-semibold text-xs text-espresso shrink-0">
            Nginx Gateway
          </div>
          <FlowArrow />
          <div className="flex-1 w-full lg:w-auto p-3 rounded-card border border-hairline bg-paper grid grid-cols-1 sm:grid-cols-3 gap-3">
            {serviceKeys.map((key) => (
              <motion.div
                key={key}
                layout
                className={`px-3 py-2 rounded-card border bg-receipt font-mono text-xs text-center transition-colors ${
                  probes === null ? TOPOLOGY_BOX.healthy : TOPOLOGY_BOX[statusOf(key)]
                }`}
              >
                {SERVICE_DEFAULTS[key].name}
              </motion.div>
            ))}
          </div>
        </div>

        <div className="pt-4 border-t border-hairline flex flex-wrap items-center justify-between gap-4">
          <span className="font-mono text-xs uppercase text-vermilion-cta">
            PIPELINE DE EVENTOS ASÍNCRONOS
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`px-3 py-1.5 rounded-card border bg-paper font-mono text-xs transition-colors ${
                probes === null ? TOPOLOGY_BOX.healthy : TOPOLOGY_BOX[statusOf('orders')]
              }`}
            >
              orders-service
            </span>
            <PipelineArrow active={brokerConnected} delay={0} />
            <span
              className={`px-3 py-1.5 rounded-card border bg-paper font-mono text-xs transition-colors ${
                brokerConnected || probes === null
                  ? 'border-hairline text-espresso'
                  : 'border-offline-red text-offline-red'
              }`}
            >
              RabbitMQ
            </span>
            <PipelineArrow active={brokerConnected} delay={0.22} />
            <span
              className={`px-3 py-1.5 rounded-card border bg-paper font-mono text-xs transition-colors ${
                probes === null ? TOPOLOGY_BOX.healthy : TOPOLOGY_BOX[statusOf('notifications')]
              }`}
            >
              notifications-service
            </span>
            <PipelineArrow active={brokerConnected && sseConnected} delay={0.44} />
            <span
              className={`px-3 py-1.5 rounded-card border bg-paper font-mono text-xs transition-colors ${
                sseConnected ? 'border-hairline text-live-green' : 'border-offline-red text-offline-red'
              }`}
            >
              SSE
            </span>
          </div>
        </div>
      </motion.section>

      {/* 3. Event stream inspector */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.14, ease: EASE_EDITORIAL }}
        className="flex flex-col gap-4"
        aria-labelledby="inspector-title"
      >
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <h2
              id="inspector-title"
              className="font-display font-bold text-lg tracking-tight text-espresso"
            >
              Inspector de Eventos
            </h2>
            <span className="font-mono text-xs uppercase text-stone">Event Stream Inspector</span>
          </div>
          <label className="relative flex items-center w-full sm:w-72 border-b border-hairline focus-within:border-espresso transition-colors pb-1.5">
            <svg
              className="w-4 h-4 text-stone mr-2 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrar por Correlation ID o pedido..."
              aria-label="Filtrar eventos"
              className="w-full bg-transparent border-0 p-0 font-mono text-xs text-espresso placeholder:text-stone focus:ring-0 focus:outline-none"
            />
          </label>
        </div>

        <div className="bg-receipt border border-hairline rounded-card overflow-x-auto">
          {notificationsOffline && events.length === 0 ? (
            <div className="px-5 py-10 flex flex-col items-center gap-2 text-center">
              <StatusLine label="OFFLINE" tone="text-offline-red" dot="bg-offline-red" />
              <p className="font-body text-sm text-stone max-w-md">
                notifications-service está offline — los eventos siguen encolados en RabbitMQ
                esperando reconexión.
              </p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-hairline font-mono text-xs uppercase text-stone">
                  <th className="py-3 px-5 font-medium">Hora</th>
                  <th className="py-3 px-4 font-medium">Evento</th>
                  <th className="py-3 px-4 font-medium">Pedido</th>
                  <th className="py-3 px-4 font-medium">Correlation ID</th>
                  <th className="py-3 px-4 font-medium">Ruta</th>
                  <th className="py-3 px-4 font-medium">Estado</th>
                  <th className="py-3 px-5 text-right font-medium">Payload</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline text-sm">
                {initialLoading ? (
                  <EventInspectorSkeleton />
                ) : filteredEvents.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center">
                      <p className="font-body text-sm text-stone">
                        {events.length === 0
                          ? 'Crea un pedido en la pestaña Menú para ver los eventos viajar por RabbitMQ en vivo.'
                          : 'Ningún evento coincide con el filtro.'}
                      </p>
                    </td>
                  </tr>
                ) : (
                  filteredEvents.map((ev) => {
                    const isOpen = expanded.has(ev.eventId)
                    const isLatest = latestNotification?.eventId === ev.eventId
                    return (
                      <Fragment key={ev.eventId}>
                        <motion.tr
                          initial={isLatest ? { backgroundColor: 'rgba(217, 78, 40, 0.12)' } : false}
                          animate={{ backgroundColor: 'rgba(217, 78, 40, 0)' }}
                          transition={{ duration: 1.2, ease: EASE_EDITORIAL }}
                          className="hover:bg-paper transition-colors"
                        >
                          <td className="py-3 px-5 font-mono text-xs text-stone tabular-nums whitespace-nowrap">
                            {formatClockTime(ev.receivedAt)}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-espresso whitespace-nowrap">
                            {ev.eventType}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-espresso tabular-nums whitespace-nowrap">
                            {ev.orderCode}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-espresso whitespace-nowrap">
                            {ev.correlationId}
                          </td>
                          <td
                            className="py-3 px-4 font-mono text-xs text-stone whitespace-nowrap"
                            title={ev.routingKey}
                          >
                            {serviceRoute(ev)}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-live-green">ACK</td>
                          <td className="py-3 px-5 text-right">
                            <button
                              type="button"
                              onClick={() => toggleExpanded(ev.eventId)}
                              aria-expanded={isOpen}
                              className={`font-mono text-xs uppercase underline underline-offset-4 hover:text-vermilion-cta transition-colors ${
                                isOpen ? 'text-vermilion-cta' : 'text-espresso'
                              }`}
                            >
                              {isOpen ? 'OCULTAR' : 'JSON'}
                            </button>
                          </td>
                        </motion.tr>
                        <AnimatePresence initial={false}>
                          {isOpen && (
                            <tr key={`${ev.eventId}-json`} className="bg-paper">
                              <td colSpan={7} className="p-0">
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: 'auto' }}
                                  exit={{ opacity: 0, height: 0 }}
                                  transition={{ duration: 0.22, ease: EASE_EDITORIAL }}
                                  className="overflow-hidden"
                                >
                                  <pre className="px-5 py-3 font-mono text-xs text-espresso overflow-x-auto">
                                    {JSON.stringify(ev.payload, null, 2)}
                                  </pre>
                                </motion.div>
                              </td>
                            </tr>
                          )}
                        </AnimatePresence>
                      </Fragment>
                    )
                  })
                )}
              </tbody>
            </table>
          )}
        </div>
      </motion.section>
    </div>
  )
}
