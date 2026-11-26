import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { ApiRequestError, createMenuItem, updateMenuItem, updateOrderStatus } from '../api'
import {
  CATEGORIES,
  formatMXN,
  formatRelativeTime,
  type Category,
  type MenuItem,
  type Order,
  type OrderStatus,
} from '../types'
import { EASE_EDITORIAL, SPRING_GENTLE, SPRING_SNAPPY } from '../motion'
import { Skeleton } from './Skeleton'

export interface KitchenViewProps {
  orders: Order[]
  menuItems: MenuItem[]
  menuLoading: boolean
  ordersLoading: boolean
  ordersError: string | null
  onOrderUpdated: (order: Order) => void
  onMenuItemUpdated: (item: MenuItem) => void
  onMenuItemCreated: (item: MenuItem) => void
  onRefreshAll: () => void
}

type KitchenSection = 'orders' | 'menu'

function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) {
    const corr = err.correlationId ? ` · ${err.correlationId}` : ''
    return `HTTP ${err.status} — ${err.message}${corr}`
  }
  return err instanceof Error ? err.message : fallback
}

function byOldest(a: Order, b: Order): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
}

export function KitchenView({
  orders,
  menuItems,
  menuLoading,
  ordersLoading,
  ordersError,
  onOrderUpdated,
  onMenuItemUpdated,
  onMenuItemCreated,
  onRefreshAll,
}: KitchenViewProps) {
  const [section, setSection] = useState<KitchenSection>('orders')
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyOrders, setBusyOrders] = useState<Set<number>>(() => new Set())
  const [busyItems, setBusyItems] = useState<Set<number>>(() => new Set())
  const [modalOpen, setModalOpen] = useState(false)
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const { pending, preparing, ready } = useMemo(
    () => ({
      pending: orders.filter((o) => o.status === 'pending').sort(byOldest),
      preparing: orders.filter((o) => o.status === 'preparing').sort(byOldest),
      ready: orders.filter((o) => o.status === 'ready').sort(byOldest),
    }),
    [orders],
  )

  async function changeStatus(order: Order, status: OrderStatus) {
    setActionError(null)
    setBusyOrders((s) => new Set(s).add(order.id))
    try {
      const res = await updateOrderStatus(order.id, status)
      onOrderUpdated(res.order)
    } catch (err) {
      setActionError(`No se pudo actualizar #${order.orderCode}: ${describeError(err, 'Error desconocido')}`)
    } finally {
      setBusyOrders((s) => {
        const next = new Set(s)
        next.delete(order.id)
        return next
      })
    }
  }

  async function toggleAvailability(item: MenuItem) {
    setActionError(null)
    setBusyItems((s) => new Set(s).add(item.id))
    try {
      const updated = await updateMenuItem(item.id, { available: !item.available })
      onMenuItemUpdated(updated)
    } catch (err) {
      setActionError(`No se pudo actualizar “${item.name}”: ${describeError(err, 'Error desconocido')}`)
    } finally {
      setBusyItems((s) => {
        const next = new Set(s)
        next.delete(item.id)
        return next
      })
    }
  }

  const bannerError = actionError ?? ordersError
  const showOrderSkeletons = ordersLoading && orders.length === 0
  const showMenuSkeletons = menuLoading && menuItems.length === 0

  return (
    <div className="flex-1 max-w-[1440px] w-full mx-auto px-6 sm:px-8 py-10 flex flex-col gap-10">
      {/* 1. Sub-header */}
      <motion.section
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: EASE_EDITORIAL }}
        className="flex flex-col gap-6 border-b border-hairline pb-6"
        aria-labelledby="kitchen-queue-title"
      >
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
          <div className="flex flex-col gap-2">
            <h1
              id="kitchen-queue-title"
              className="font-display font-bold text-3xl tracking-tight text-espresso"
            >
              Cola de Cocina
            </h1>
            <div className="flex items-center gap-6 pt-1" role="tablist" aria-label="Sección de cocina">
              {(
                [
                  ['orders', 'Pedidos'],
                  ['menu', 'Disponibilidad del Menú'],
                ] as const
              ).map(([key, label]) => {
                const active = section === key
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSection(key)}
                    className={`relative pb-2 font-mono text-xs uppercase tracking-wider transition-colors ${
                      active ? 'text-espresso' : 'text-stone hover:text-espresso'
                    }`}
                  >
                    {label}
                    {active && (
                      <motion.span
                        layoutId="kitchen-section-underline"
                        className="absolute left-0 right-0 bottom-0 h-0.5 bg-espresso"
                        transition={SPRING_SNAPPY}
                      />
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            {showOrderSkeletons ? (
              <Skeleton className="h-3.5 w-52" />
            ) : (
              <motion.span
                key={`${pending.length}-${preparing.length}-${ready.length}`}
                initial={{ opacity: 0.6 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2 }}
                className="font-mono text-xs uppercase text-stone tabular-nums"
                aria-live="polite"
              >
                {`${pending.length} PENDIENTES · ${preparing.length} PREPARANDO · ${ready.length} LISTOS`}
              </motion.span>
            )}
            <motion.button
              type="button"
              whileTap={{ scale: 0.96 }}
              onClick={() => {
                setActionError(null)
                onRefreshAll()
              }}
              disabled={ordersLoading}
              className="font-mono text-xs uppercase tracking-wider text-stone hover:text-espresso disabled:opacity-50 transition-colors"
            >
              {ordersLoading ? 'Actualizando…' : 'Actualizar'}
            </motion.button>
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => setModalOpen(true)}
              className="px-4 py-2.5 rounded-card bg-espresso hover:bg-stone text-receipt font-display font-semibold text-xs tracking-tight transition-colors"
            >
              + Nuevo Platillo
            </motion.button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {bannerError && (
            <motion.div
              key="kitchen-error"
              role="alert"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2, ease: EASE_EDITORIAL }}
              className="flex items-start justify-between gap-4 bg-receipt border border-offline-red/40 rounded-card px-4 py-3"
            >
              <div className="flex flex-col gap-1">
                <span className="font-mono text-xs uppercase tracking-wider text-offline-red">
                  Error de servicio
                </span>
                <span className="font-body text-sm text-espresso break-words">{bannerError}</span>
              </div>
              {actionError && (
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  className="font-mono text-xs uppercase text-stone hover:text-espresso transition-colors"
                >
                  Cerrar
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.section>

      {/* 2. Order board */}
      <AnimatePresence initial={false}>
        {section === 'orders' && (
          <motion.div
            key="kitchen-orders-board"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: EASE_EDITORIAL }}
          >
            <LayoutGroup id="kitchen-board">
              <section
                className="grid grid-cols-1 lg:grid-cols-3 lg:divide-x lg:divide-hairline border-b border-hairline pb-10"
                aria-label="Tablero de pedidos"
              >
                <OrderColumn
                  title="PENDIENTES"
                  titleClass="text-espresso"
                  paddingClass="lg:pr-6 pb-8 lg:pb-0"
                  orders={pending}
                  showSkeleton={showOrderSkeletons}
                  skeletonCount={2}
                  busyOrders={busyOrders}
                  onAction={changeStatus}
                />
                <OrderColumn
                  title="PREPARANDO"
                  titleClass="text-vermilion-cta"
                  paddingClass="lg:px-6 pb-8 lg:pb-0"
                  orders={preparing}
                  showSkeleton={showOrderSkeletons}
                  skeletonCount={1}
                  busyOrders={busyOrders}
                  onAction={changeStatus}
                />
                <OrderColumn
                  title="LISTOS PARA RECOGER"
                  titleClass="text-live-green"
                  paddingClass="lg:pl-6"
                  orders={ready}
                  showSkeleton={showOrderSkeletons}
                  skeletonCount={1}
                  busyOrders={busyOrders}
                  onAction={changeStatus}
                />
              </section>
            </LayoutGroup>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 3. Menu availability */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.06, ease: EASE_EDITORIAL }}
        className="flex flex-col gap-4"
        aria-labelledby="menu-availability-title"
      >
        <div className="flex items-baseline justify-between">
          <h2
            id="menu-availability-title"
            className="font-display font-bold text-lg tracking-tight text-espresso"
          >
            Disponibilidad del Menú
          </h2>
          {showMenuSkeletons ? (
            <Skeleton className="h-3.5 w-24" />
          ) : (
            <span className="font-mono text-xs uppercase text-stone tabular-nums">
              {menuItems.length} {menuItems.length === 1 ? 'PLATILLO' : 'PLATILLOS'}
            </span>
          )}
        </div>
        <div className="bg-receipt border border-hairline rounded-card overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-hairline font-mono text-xs uppercase text-stone">
                <th className="py-3 px-5 font-medium">Platillo</th>
                <th className="py-3 px-4 font-medium">Categoría</th>
                <th className="py-3 px-4 font-medium">Precio</th>
                <th className="py-3 px-4 font-medium">Estado</th>
                <th className="py-3 px-5 text-right font-medium">Disponible</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline text-sm">
              {showMenuSkeletons ? (
                <AvailabilitySkeletonRows />
              ) : menuItems.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 px-5 text-center font-mono text-xs uppercase text-stone">
                    Sin platillos en el menú
                  </td>
                </tr>
              ) : (
                menuItems.map((item) => (
                  <AvailabilityRow
                    key={item.id}
                    item={item}
                    busy={busyItems.has(item.id)}
                    onToggle={() => toggleAvailability(item)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </motion.section>

      <AnimatePresence>
        {modalOpen && (
          <NewDishModal
            onClose={() => setModalOpen(false)}
            onCreated={(item) => {
              onMenuItemCreated(item)
              setModalOpen(false)
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// --- Order board ---

interface OrderColumnProps {
  title: string
  titleClass: string
  paddingClass: string
  orders: Order[]
  showSkeleton: boolean
  skeletonCount: number
  busyOrders: Set<number>
  onAction: (order: Order, status: OrderStatus) => void
}

function OrderChitSkeleton() {
  return (
    <div className="bg-receipt border border-hairline rounded-card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-3.5 w-14" />
      </div>
      <Skeleton className="h-5 w-36" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-3/5" />
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-hairline">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3.5 w-16" />
      </div>
      <Skeleton className="h-9 w-full rounded-card" />
    </div>
  )
}

function OrderColumn({
  title,
  titleClass,
  paddingClass,
  orders,
  showSkeleton,
  skeletonCount,
  busyOrders,
  onAction,
}: OrderColumnProps) {
  return (
    <div className={`${paddingClass} flex flex-col gap-4`}>
      <header className="flex items-center justify-between pb-2 border-b border-hairline">
        <h2 className={`font-mono text-xs uppercase tracking-wider ${titleClass}`}>{title}</h2>
        {showSkeleton ? (
          <Skeleton className="h-3.5 w-4" />
        ) : (
          <motion.span
            key={orders.length}
            initial={{ scale: 0.8, opacity: 0.5 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={SPRING_SNAPPY}
            className="font-mono text-xs text-stone tabular-nums"
          >
            {orders.length}
          </motion.span>
        )}
      </header>
      <div className="flex flex-col gap-4">
        {showSkeleton ? (
          Array.from({ length: skeletonCount }).map((_, i) => <OrderChitSkeleton key={i} />)
        ) : (
          <>
            <AnimatePresence mode="popLayout" initial={false}>
              {orders.map((order) => (
                <OrderChit key={order.id} order={order} busy={busyOrders.has(order.id)} onAction={onAction} />
              ))}
            </AnimatePresence>
            {orders.length === 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2 }}
                className="border border-dashed border-hairline rounded-card py-8 text-center font-mono text-xs uppercase text-stone"
              >
                Sin pedidos
              </motion.div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const ACTION_BASE =
  'w-full py-2.5 px-4 rounded-card font-display font-semibold text-xs tracking-tight transition-colors disabled:opacity-60 disabled:cursor-wait'

function OrderChit({
  order,
  busy,
  onAction,
}: {
  order: Order
  busy: boolean
  onAction: (order: Order, status: OrderStatus) => void
}) {
  let primary: { label: string; next: OrderStatus; className: string } | null = null
  if (order.status === 'pending') {
    primary = { label: 'Empezar a Preparar', next: 'preparing', className: 'bg-espresso hover:bg-stone text-receipt' }
  } else if (order.status === 'preparing') {
    primary = {
      label: 'Marcar Listo',
      next: 'ready',
      className: 'bg-vermilion-cta hover:bg-vermilion-hover text-receipt',
    }
  } else if (order.status === 'ready') {
    primary = {
      label: 'Marcar Entregado',
      next: 'delivered',
      className: 'bg-receipt border border-hairline hover:border-espresso text-espresso',
    }
  }

  return (
    <motion.article
      layout
      layoutId={`order-${order.id}`}
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={SPRING_GENTLE}
      className="bg-receipt border border-hairline hover:border-stone/45 rounded-card p-5 flex flex-col gap-4 transition-colors"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase text-espresso tabular-nums">#{order.orderCode}</span>
        <span className="font-mono text-xs uppercase text-stone tabular-nums">
          {formatRelativeTime(order.createdAt)}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-display font-semibold text-base tracking-tight text-espresso">{order.studentName}</p>
        {order.notes && <p className="font-body text-sm italic text-stone">“{order.notes}”</p>}
      </div>
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1 font-body text-sm text-stone">
          {order.items.map((it) => (
            <li key={it.id}>{`${it.quantity}× ${it.itemName}`}</li>
          ))}
        </ul>
        <div className="flex items-center justify-between pt-3 border-t border-hairline">
          <span className="font-mono text-xs uppercase text-stone">Total</span>
          <span className="font-mono text-xs text-espresso tabular-nums">{formatMXN(order.totalCents)}</span>
        </div>
      </div>
      {primary && (
        <div className="flex flex-col gap-2">
          <motion.button
            type="button"
            whileTap={busy ? undefined : { scale: 0.98 }}
            transition={SPRING_SNAPPY}
            disabled={busy}
            onClick={() => primary && onAction(order, primary.next)}
            className={`${ACTION_BASE} ${primary.className}`}
          >
            {busy ? 'Actualizando…' : primary.label}
          </motion.button>
          {order.status === 'pending' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(order, 'cancelled')}
              className="self-center font-mono text-xs uppercase tracking-wider text-stone hover:text-offline-red disabled:opacity-50 transition-colors"
            >
              Cancelar
            </button>
          )}
        </div>
      )}
    </motion.article>
  )
}

// --- Availability table ---

function AvailabilitySkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i}>
          <td className="py-3 px-5">
            <div className="flex items-center gap-3">
              <Skeleton className="w-9 h-9 rounded-md shrink-0" />
              <Skeleton className="h-4 w-36" />
            </div>
          </td>
          <td className="py-3 px-4">
            <Skeleton className="h-3.5 w-20" />
          </td>
          <td className="py-3 px-4">
            <Skeleton className="h-3.5 w-16" />
          </td>
          <td className="py-3 px-4">
            <Skeleton className="h-3.5 w-20" />
          </td>
          <td className="py-3 px-5 text-right">
            <Skeleton className="h-5 w-9 rounded-full ml-auto" />
          </td>
        </tr>
      ))}
    </>
  )
}

function AvailabilityRow({ item, busy, onToggle }: { item: MenuItem; busy: boolean; onToggle: () => void }) {
  const [imgFailed, setImgFailed] = useState(false)
  const muted = !item.available
  const showImage = item.imageUrl && !imgFailed

  return (
    <tr className="hover:bg-paper/50 transition-colors">
      <td className="py-3 px-5">
        <div className="flex items-center gap-3">
          {showImage ? (
            <img
              src={item.imageUrl ?? undefined}
              alt={item.name}
              onError={() => setImgFailed(true)}
              className={`w-9 h-9 rounded-md border border-hairline object-cover shrink-0 transition ${
                muted ? 'grayscale-[60%] opacity-50' : ''
              }`}
            />
          ) : (
            <span
              aria-hidden="true"
              className={`w-9 h-9 rounded-md border border-hairline bg-paper shrink-0 inline-flex items-center justify-center text-lg transition ${
                muted ? 'grayscale-[60%] opacity-50' : ''
              }`}
            >
              {item.emoji || '🍽️'}
            </span>
          )}
          <span
            className={`font-display font-semibold text-sm tracking-tight transition-colors ${
              muted ? 'text-stone' : 'text-espresso'
            }`}
          >
            {item.name}
          </span>
        </div>
      </td>
      <td className="py-3 px-4 font-mono text-xs uppercase text-stone">{item.category}</td>
      <td className={`py-3 px-4 font-mono text-xs tabular-nums ${muted ? 'text-stone' : 'text-espresso'}`}>
        {formatMXN(item.priceCents)}
      </td>
      <td className={`py-3 px-4 font-mono text-xs uppercase ${muted ? 'text-stone' : 'text-espresso'}`}>
        {item.available ? 'DISPONIBLE' : 'AGOTADO'}
      </td>
      <td className="py-3 px-5 text-right">
        <button
          type="button"
          role="switch"
          aria-checked={item.available}
          aria-label={`Cambiar disponibilidad de ${item.name}`}
          disabled={busy}
          onClick={onToggle}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-60 disabled:cursor-wait ${
            item.available ? 'bg-espresso justify-end' : 'bg-hairline justify-start'
          }`}
        >
          <motion.span layout transition={SPRING_SNAPPY} className="block h-4 w-4 rounded-full bg-receipt" />
        </button>
      </td>
    </tr>
  )
}

// --- New dish modal ---

const INPUT_CLASS =
  'w-full bg-receipt border border-hairline rounded-card px-3 py-2.5 font-body text-sm text-espresso placeholder:text-stone/60 focus:outline-none focus:border-espresso transition-colors'
const LABEL_CLASS = 'font-mono text-xs uppercase tracking-wider text-stone'

function NewDishModal({ onClose, onCreated }: { onClose: () => void; onCreated: (item: MenuItem) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<Category>(CATEGORIES[0])
  const [price, setPrice] = useState('')
  const [prepMinutes, setPrepMinutes] = useState('10')
  const [imageUrl, setImageUrl] = useState('')
  const [emoji, setEmoji] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, submitting])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const priceNumber = Number(price)
    if (!name.trim()) return setError('El nombre es obligatorio.')
    if (!description.trim()) return setError('La descripción es obligatoria.')
    if (!Number.isFinite(priceNumber) || priceNumber <= 0) return setError('Ingresa un precio válido en MXN.')
    const prep = Number(prepMinutes)

    setSubmitting(true)
    setError(null)
    try {
      const item = await createMenuItem({
        name: name.trim(),
        description: description.trim(),
        category,
        priceCents: Math.round(priceNumber * 100),
        available: true,
        prepMinutes: Number.isFinite(prep) && prep > 0 ? Math.round(prep) : undefined,
        emoji: emoji.trim() || undefined,
        imageUrl: imageUrl.trim() || null,
      })
      onCreated(item)
    } catch (err) {
      setError(describeError(err, 'No se pudo crear el platillo'))
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-espresso/30 backdrop-blur-[2px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: EASE_EDITORIAL }}
      onClick={() => !submitting && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-dish-title"
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.22, ease: EASE_EDITORIAL }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto bg-receipt border border-hairline rounded-card shadow-[0_20px_48px_-24px_rgba(22,20,18,0.28)]"
      >
        <form onSubmit={handleSubmit} className="flex flex-col">
          <header className="flex items-baseline justify-between px-6 pt-6 pb-4 border-b border-hairline">
            <h2 id="new-dish-title" className="font-display font-bold text-lg tracking-tight text-espresso">
              Nuevo Platillo
            </h2>
            <span className="font-mono text-xs uppercase text-stone">menu-service</span>
          </header>

          <div className="flex flex-col gap-4 px-6 py-5">
            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLASS}>Nombre</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Chilaquiles verdes"
                className={INPUT_CLASS}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL_CLASS}>Descripción</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Totopos bañados en salsa verde con crema, queso y cebolla."
                className={`${INPUT_CLASS} resize-none`}
              />
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="flex flex-col gap-1.5">
                <span className={LABEL_CLASS}>Categoría</span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as Category)}
                  className={INPUT_CLASS}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL_CLASS}>Precio (MXN)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.5"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="65"
                  className={`${INPUT_CLASS} font-mono tabular-nums`}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL_CLASS}>Preparación (min)</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={prepMinutes}
                  onChange={(e) => setPrepMinutes(e.target.value)}
                  className={`${INPUT_CLASS} font-mono tabular-nums`}
                />
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_96px] gap-4">
              <label className="flex flex-col gap-1.5">
                <span className={LABEL_CLASS}>Ruta de imagen (opcional)</span>
                <input
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="/images/chilaquiles-verdes.jpeg"
                  className={`${INPUT_CLASS} font-mono text-xs`}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL_CLASS}>Emoji</span>
                <input
                  value={emoji}
                  onChange={(e) => setEmoji(e.target.value)}
                  placeholder="🌮"
                  maxLength={8}
                  className={`${INPUT_CLASS} text-center`}
                />
              </label>
            </div>

            {error && (
              <p role="alert" className="font-body text-sm text-offline-red">
                {error}
              </p>
            )}
          </div>

          <footer className="flex items-center justify-end gap-4 px-6 py-4 border-t border-hairline">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="font-mono text-xs uppercase tracking-wider text-stone hover:text-espresso disabled:opacity-50 transition-colors"
            >
              Cancelar
            </button>
            <motion.button
              type="submit"
              whileTap={submitting ? undefined : { scale: 0.97 }}
              disabled={submitting}
              className="px-4 py-2.5 rounded-card bg-espresso hover:bg-stone text-receipt font-display font-semibold text-xs tracking-tight transition-colors disabled:opacity-60 disabled:cursor-wait"
            >
              {submitting ? 'Guardando…' : 'Crear Platillo'}
            </motion.button>
          </footer>
        </form>
      </motion.div>
    </motion.div>
  )
}
