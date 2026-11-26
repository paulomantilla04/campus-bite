import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { AppView, NotificationItem } from '../types'
import { formatRelativeTime } from '../types'
import { EASE_EDITORIAL, SPRING_SNAPPY } from '../motion'

export interface TopBarProps {
  activeView: AppView
  onViewChange: (view: AppView) => void
  sseConnected: boolean
  notifications: NotificationItem[]
  unreadCount: number
  onMarkRead: (id: number) => void
  onMarkAllRead: () => void
}

const NAV_ITEMS: { view: AppView; label: string }[] = [
  { view: 'menu', label: 'Menú' },
  { view: 'kitchen', label: 'Cocina' },
  { view: 'lab', label: 'Lab' },
]

export function TopBar({
  activeView,
  onViewChange,
  sseConnected,
  notifications,
  unreadCount,
  onMarkRead,
  onMarkAllRead,
}: TopBarProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointer = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <header className="sticky top-0 z-30 h-14 bg-paper/95 backdrop-blur-xs border-b border-hairline">
      <div className="max-w-[1440px] mx-auto px-6 sm:px-8 h-full flex items-center justify-between gap-4">
        <motion.button
          type="button"
          whileTap={{ scale: 0.98 }}
          onClick={() => onViewChange('menu')}
          className="flex items-baseline gap-2.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-espresso rounded-sm"
        >
          <span className="font-display font-bold text-base tracking-tight text-espresso">CAMPUSBITE</span>
          <span className="font-mono text-xs text-stone hidden sm:inline">/</span>
          <span className="font-body text-sm text-stone hidden sm:inline">Cafetería</span>
        </motion.button>

        <nav aria-label="Vistas principales" className="h-full flex items-center gap-5 sm:gap-8">
          {NAV_ITEMS.map(({ view, label }) => {
            const active = view === activeView
            return (
              <button
                key={view}
                type="button"
                onClick={() => onViewChange(view)}
                aria-current={active ? 'page' : undefined}
                className={`relative h-full inline-flex items-center font-display font-semibold text-sm tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-espresso ${
                  active ? 'text-espresso' : 'text-stone hover:text-espresso'
                }`}
              >
                {label}
                {active && (
                  <motion.span
                    layoutId="top-nav-underline"
                    className="absolute left-0 right-0 -bottom-px h-[2px] bg-espresso"
                    transition={SPRING_SNAPPY}
                  />
                )}
              </button>
            )
          })}
        </nav>

        <div ref={wrapperRef} className="relative flex items-center gap-4 sm:gap-6 shrink-0">
          <div
            role="status"
            aria-live="polite"
            className="hidden md:inline-flex items-center gap-2 font-mono text-xs uppercase text-espresso"
          >
            <span className="relative flex w-1.5 h-1.5">
              {sseConnected && (
                <motion.span
                  className="absolute inline-flex h-full w-full rounded-full bg-live-green"
                  animate={{ scale: [1, 2.3], opacity: [0.55, 0] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
                />
              )}
              <span
                className={`relative inline-flex w-1.5 h-1.5 rounded-full transition-colors ${
                  sseConnected ? 'bg-live-green' : 'bg-offline-red'
                }`}
              />
            </span>
            <span>{sseConnected ? 'Live' : 'Offline'}</span>
          </div>

          <motion.button
            type="button"
            whileTap={{ scale: 0.97 }}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="notif-popover"
            aria-label={`Notificaciones, ${unreadCount} sin leer`}
            className="inline-flex items-center gap-2 font-body text-sm text-espresso hover:text-vermilion transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-espresso rounded-sm"
          >
            <span className="hidden sm:inline">Notificaciones</span>
            <span className="sm:hidden font-mono text-xs uppercase">Alertas</span>
            <motion.span
              key={unreadCount}
              initial={{ scale: 0.82 }}
              animate={{ scale: 1 }}
              transition={SPRING_SNAPPY}
              className={`font-mono text-xs border px-1.5 py-0.5 rounded-card tabular-nums transition-colors ${
                unreadCount > 0
                  ? 'border-espresso bg-espresso text-receipt'
                  : 'border-hairline bg-receipt text-espresso'
              }`}
            >
              {unreadCount}
            </motion.span>
          </motion.button>

          <AnimatePresence>
            {open && (
              <motion.div
                id="notif-popover"
                role="dialog"
                aria-label="Alertas"
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.18, ease: EASE_EDITORIAL }}
                style={{ transformOrigin: 'top right' }}
                className="absolute right-0 top-10 w-80 sm:w-96 bg-receipt border border-hairline rounded-card p-4 z-50 shadow-[0_12px_32px_-16px_rgba(22,20,18,0.18)]"
              >
                <div className="flex items-center justify-between gap-3 pb-3 border-b border-hairline">
                  <span className="font-mono text-xs uppercase text-stone">Alertas</span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-stone tabular-nums">{unreadCount} SIN LEER</span>
                    {unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={onMarkAllRead}
                        className="font-mono text-xs uppercase text-espresso underline underline-offset-2 hover:text-vermilion transition-colors"
                      >
                        Marcar leídas
                      </button>
                    )}
                  </div>
                </div>

                {notifications.length === 0 ? (
                  <div className="py-8 flex flex-col items-center gap-1 text-center">
                    <span className="font-mono text-xs uppercase text-stone">Sin alertas</span>
                    <span className="font-body text-sm text-stone">
                      Las actualizaciones de tus pedidos aparecerán aquí.
                    </span>
                  </div>
                ) : (
                  <ul className="max-h-80 overflow-y-auto divide-y divide-hairline -mx-1">
                    {notifications.map((n, index) => (
                      <motion.li
                        key={n.eventId || n.id}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.18, delay: Math.min(index * 0.025, 0.15), ease: EASE_EDITORIAL }}
                      >
                        <button
                          type="button"
                          onClick={() => !n.read && onMarkRead(n.id)}
                          className="w-full text-left px-1 py-3 flex gap-2.5 hover:bg-paper/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-espresso rounded-sm"
                        >
                          <span className="pt-1.5 w-1.5 shrink-0">
                            {!n.read && <span className="block w-1.5 h-1.5 rounded-full bg-vermilion" />}
                          </span>
                          <span className="min-w-0 flex-1 flex flex-col gap-1">
                            <span className="flex items-baseline justify-between gap-2">
                              <span
                                className={`font-body text-sm truncate ${
                                  n.read ? 'text-stone' : 'text-espresso font-semibold'
                                }`}
                              >
                                {n.title}
                              </span>
                              <span className="font-mono text-[10px] uppercase text-stone tabular-nums shrink-0">
                                {formatRelativeTime(n.createdAt)}
                              </span>
                            </span>
                            <span className="font-body text-sm text-stone leading-snug">{n.message}</span>
                            <span className="font-mono text-[10px] text-stone/80 truncate">{n.correlationId}</span>
                          </span>
                        </button>
                      </motion.li>
                    ))}
                  </ul>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  )
}

export default TopBar
