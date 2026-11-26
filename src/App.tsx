import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import {
  fetchMenuItems,
  fetchNotifications,
  fetchOrders,
  markAllNotificationsRead,
  markNotificationRead,
  openNotificationStream,
} from './api'
import type { AppView, MenuItem, NotificationItem, Order } from './types'
import { formatClockTime } from './types'
import { EASE_EDITORIAL } from './motion'
import { TopBar } from './components/TopBar'
import { StudentView } from './components/StudentView'
import { KitchenView } from './components/KitchenView'
import { MicroservicesLabView } from './components/MicroservicesLabView'

const STUDENT_NAME_KEY = 'campusbite:studentName'
const DEFAULT_STUDENT_NAME = 'Ana García'
const TOAST_DURATION_MS = 4500
const MAX_NOTIFICATIONS = 50

function readStoredName(): string {
  try {
    return localStorage.getItem(STUDENT_NAME_KEY) || DEFAULT_STUDENT_NAME
  } catch {
    return DEFAULT_STUDENT_NAME
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

function sameNotification(a: NotificationItem, b: NotificationItem): boolean {
  return a.id === b.id || (!!a.eventId && a.eventId === b.eventId)
}

function App() {
  const [activeView, setActiveView] = useState<AppView>('menu')
  const [studentName, setStudentName] = useState<string>(readStoredName)

  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [menuLoading, setMenuLoading] = useState(true)
  const [menuError, setMenuError] = useState<string | null>(null)

  const [orders, setOrders] = useState<Order[]>([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [ordersError, setOrdersError] = useState<string | null>(null)

  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [latestNotification, setLatestNotification] = useState<NotificationItem | null>(null)
  const [sseConnected, setSseConnected] = useState(false)

  const [toast, setToast] = useState<NotificationItem | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const notificationsRef = useRef<NotificationItem[]>([])

  useEffect(() => {
    notificationsRef.current = notifications
  }, [notifications])

  useEffect(() => {
    try {
      localStorage.setItem(STUDENT_NAME_KEY, studentName)
    } catch {
      // storage unavailable (private mode)
    }
  }, [studentName])

  const loadMenu = useCallback(async () => {
    setMenuLoading(true)
    setMenuError(null)
    try {
      setMenuItems(await fetchMenuItems())
    } catch (err) {
      setMenuError(errorMessage(err, 'No se pudo cargar el menú'))
    } finally {
      setMenuLoading(false)
    }
  }, [])

  const loadOrders = useCallback(async (quiet = false) => {
    if (!quiet) {
      setOrdersLoading(true)
      setOrdersError(null)
    }
    try {
      setOrders(await fetchOrders())
      setOrdersError(null)
    } catch (err) {
      if (!quiet) setOrdersError(errorMessage(err, 'No se pudieron cargar los pedidos'))
    } finally {
      if (!quiet) setOrdersLoading(false)
    }
  }, [])

  const refreshAll = useCallback(() => {
    void loadMenu()
    void loadOrders()
  }, [loadMenu, loadOrders])

  const handleViewChange = useCallback((view: AppView) => {
    setActiveView(view)
    if (window.scrollY > 0) {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    }
  }, [])

  useEffect(() => {
    let active = true

    fetchMenuItems()
      .then((items) => {
        if (!active) return
        setMenuItems(items)
        setMenuError(null)
      })
      .catch((err) => {
        if (!active) return
        setMenuError(errorMessage(err, 'No se pudo cargar el menú'))
      })
      .finally(() => {
        if (active) setMenuLoading(false)
      })

    fetchOrders()
      .then((list) => {
        if (!active) return
        setOrders(list)
        setOrdersError(null)
      })
      .catch((err) => {
        if (!active) return
        setOrdersError(errorMessage(err, 'No se pudieron cargar los pedidos'))
      })
      .finally(() => {
        if (active) setOrdersLoading(false)
      })

    fetchNotifications({ limit: MAX_NOTIFICATIONS })
      .then(({ notifications: list, unreadCount: count }) => {
        if (!active) return
        setNotifications(list)
        setUnreadCount(count)
      })
      .catch(() => {
        // notifications-service may be down; SSE recovers automatically
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const es = openNotificationStream()

    const handleConnected = () => setSseConnected(true)
    const handleNotification = (e: MessageEvent<string>) => {
      let incoming: NotificationItem
      try {
        incoming = JSON.parse(e.data) as NotificationItem
      } catch {
        return
      }
      if (notificationsRef.current.some((n) => sameNotification(n, incoming))) return

      const next = [incoming, ...notificationsRef.current].slice(0, MAX_NOTIFICATIONS)
      notificationsRef.current = next
      setNotifications(next)
      if (!incoming.read) setUnreadCount((c) => c + 1)
      setLatestNotification(incoming)

      setToast(incoming)
      window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setToast(null), TOAST_DURATION_MS)

      void loadOrders(true)
    }

    es.onopen = handleConnected
    es.onerror = () => setSseConnected(false)
    es.addEventListener('connected', handleConnected)
    es.addEventListener('notification', handleNotification as EventListener)

    return () => {
      es.removeEventListener('connected', handleConnected)
      es.removeEventListener('notification', handleNotification as EventListener)
      es.close()
      window.clearTimeout(toastTimer.current)
    }
  }, [loadOrders])

  const handleMarkRead = useCallback((id: number) => {
    const target = notificationsRef.current.find((n) => n.id === id)
    if (!target || target.read) return
    setNotifications((list) => list.map((n) => (n.id === id ? { ...n, read: true } : n)))
    setUnreadCount((c) => Math.max(0, c - 1))
    markNotificationRead(id).catch(() => {})
  }, [])

  const handleMarkAllRead = useCallback(() => {
    setNotifications((list) => list.map((n) => ({ ...n, read: true })))
    setUnreadCount(0)
    markAllNotificationsRead().catch(() => {})
  }, [])

  const handleOrderCreated = useCallback((order: Order) => {
    setOrders((list) => [order, ...list.filter((o) => o.id !== order.id)])
  }, [])

  const handleOrderUpdated = useCallback((order: Order) => {
    setOrders((list) => list.map((o) => (o.id === order.id ? order : o)))
  }, [])

  const handleMenuItemUpdated = useCallback((item: MenuItem) => {
    setMenuItems((list) => list.map((m) => (m.id === item.id ? item : m)))
  }, [])

  const handleMenuItemCreated = useCallback((item: MenuItem) => {
    setMenuItems((list) => [...list.filter((m) => m.id !== item.id), item])
  }, [])

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-paper text-espresso flex flex-col">
        <TopBar
          activeView={activeView}
          onViewChange={handleViewChange}
          sseConnected={sseConnected}
          notifications={notifications}
          unreadCount={unreadCount}
          onMarkRead={handleMarkRead}
          onMarkAllRead={handleMarkAllRead}
        />

        {/* Opacity-only crossfade on the outer container preserves position:sticky and prevents viewport height flicker */}
        <main className="flex-1 min-h-[calc(100dvh-56px)] flex flex-col">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeView}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: EASE_EDITORIAL }}
              className="flex-1 flex flex-col"
            >
              {activeView === 'menu' && (
                <StudentView
                  menuItems={menuItems}
                  orders={orders}
                  ordersLoading={ordersLoading}
                  studentName={studentName}
                  onStudentNameChange={setStudentName}
                  onOrderCreated={handleOrderCreated}
                  menuLoading={menuLoading}
                  menuError={menuError}
                  onRetryMenu={loadMenu}
                />
              )}
              {activeView === 'kitchen' && (
                <KitchenView
                  orders={orders}
                  menuItems={menuItems}
                  menuLoading={menuLoading}
                  ordersLoading={ordersLoading}
                  ordersError={ordersError}
                  onOrderUpdated={handleOrderUpdated}
                  onMenuItemUpdated={handleMenuItemUpdated}
                  onMenuItemCreated={handleMenuItemCreated}
                  onRefreshAll={refreshAll}
                />
              )}
              {activeView === 'lab' && (
                <MicroservicesLabView
                  sseConnected={sseConnected}
                  latestNotification={latestNotification}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Live editorial toast */}
        <div className="fixed bottom-6 left-6 z-40 pointer-events-none" aria-live="polite">
          <AnimatePresence>
            {toast && (
              <motion.div
                key={toast.eventId || toast.id}
                initial={{ opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.98 }}
                transition={{ duration: 0.24, ease: EASE_EDITORIAL }}
                className="pointer-events-auto w-80 max-w-[calc(100vw-3rem)] bg-receipt border border-hairline rounded-card px-4 py-3 flex gap-3 shadow-[0_6px_24px_-12px_rgba(22,20,18,0.18)]"
              >
                <span className="mt-1.5 w-1.5 h-1.5 shrink-0 rounded-full bg-vermilion" />
                <div className="min-w-0 flex-1 flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-wide text-stone">
                      En vivo · {toast.orderCode}
                    </span>
                    <span className="font-mono text-[10px] text-stone tabular-nums">
                      {formatClockTime(toast.createdAt)}
                    </span>
                  </div>
                  <span className="font-body text-sm font-semibold text-espresso truncate">{toast.title}</span>
                  <span className="font-body text-sm text-stone leading-snug line-clamp-2">{toast.message}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setToast(null)}
                  aria-label="Cerrar alerta"
                  className="self-start font-mono text-xs text-stone hover:text-espresso transition-colors"
                >
                  ×
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </MotionConfig>
  )
}

export default App
