import { useMemo, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { ApiRequestError, createOrder } from '../api'
import type { Category, MenuItem, Order, OrderStatus } from '../types'
import { CATEGORIES, formatClockTime, formatMXN, formatShortPrice } from '../types'
import { EASE_EDITORIAL, SPRING_GENTLE, SPRING_SNAPPY } from '../motion'
import { Skeleton } from './Skeleton'

export interface StudentViewProps {
  menuItems: MenuItem[]
  orders: Order[]
  ordersLoading: boolean
  studentName: string
  onStudentNameChange: (name: string) => void
  onOrderCreated: (order: Order, eventPublished: boolean) => void
  menuLoading: boolean
  menuError: string | null
  onRetryMenu: () => void
}

type CategoryFilter = 'Todas' | Category

const FILTERS: CategoryFilter[] = ['Todas', ...CATEGORIES]

const STATUS_STEPS: { key: OrderStatus; label: string }[] = [
  { key: 'pending', label: 'Pendiente' },
  { key: 'preparing', label: 'Preparando' },
  { key: 'ready', label: 'Listo' },
]

interface SubmitError {
  title: string
  message: string
  correlationId?: string
}

interface Confirmation {
  orderCode: string
  correlationId: string
  eventPublished: boolean
}

function describeOrderError(err: unknown): SubmitError {
  if (err instanceof ApiRequestError) {
    if (err.status === 400) {
      return {
        title: 'Pedido rechazado',
        message: `${err.message}. Revisa tu pedido: algún platillo pudo agotarse en cocina.`,
        correlationId: err.correlationId,
      }
    }
    if (err.status === 429) {
      return {
        title: 'Demasiadas peticiones (429)',
        message: 'El gateway limitó tus pedidos por un momento. Espera unos segundos y vuelve a intentarlo; tu carrito sigue intacto.',
        correlationId: err.correlationId,
      }
    }
    if (err.status >= 500) {
      return {
        title: `Servicio no disponible (${err.status})`,
        message: `${err.message}. orders-service no pudo validar el menú; intenta de nuevo en un momento.`,
        correlationId: err.correlationId,
      }
    }
    return { title: `Error ${err.status}`, message: err.message, correlationId: err.correlationId }
  }
  return {
    title: 'Error inesperado',
    message: err instanceof Error ? err.message : 'No se pudo crear el pedido.',
  }
}

function Stepper({
  qty,
  label,
  onChange,
  variant,
}: {
  qty: number
  label: string
  onChange: (delta: number) => void
  variant: 'dark' | 'outline'
}) {
  const shell =
    variant === 'dark'
      ? 'bg-espresso text-receipt'
      : 'border border-hairline text-espresso bg-receipt'
  const btn =
    variant === 'dark'
      ? 'px-2.5 py-1.5 text-xs hover:bg-stone transition-colors'
      : 'px-2 py-1 text-xs hover:bg-paper transition-colors'
  return (
    <div className={`inline-flex items-center rounded-card overflow-hidden ${shell}`}>
      <motion.button
        type="button"
        whileTap={{ scale: 0.88 }}
        onClick={() => onChange(-1)}
        aria-label={`Quitar ${label}`}
        className={btn}
      >
        −
      </motion.button>
      <span className="relative px-2 font-mono text-xs tabular-nums min-w-[1.6rem] text-center overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={qty}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.14, ease: EASE_EDITORIAL }}
            className="inline-block"
          >
            {qty}
          </motion.span>
        </AnimatePresence>
      </span>
      <motion.button
        type="button"
        whileTap={{ scale: 0.88 }}
        onClick={() => onChange(1)}
        aria-label={`Agregar ${label}`}
        className={btn}
      >
        +
      </motion.button>
    </div>
  )
}

function DishImage({ item }: { item: MenuItem }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const dim = item.available ? '' : 'grayscale-[60%] opacity-50'

  if (!item.imageUrl || failed) {
    return (
      <div
        aria-hidden="true"
        className={`w-24 h-24 shrink-0 rounded-md border border-hairline bg-paper flex items-center justify-center text-4xl ${dim}`}
      >
        {item.emoji || '🍽️'}
      </div>
    )
  }

  return (
    <div className="relative w-24 h-24 shrink-0 rounded-md border border-hairline overflow-hidden bg-paper">
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      <motion.img
        src={item.imageUrl}
        alt={item.name}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        initial={{ opacity: 0 }}
        animate={{ opacity: loaded ? 1 : 0 }}
        transition={{ duration: 0.28, ease: EASE_EDITORIAL }}
        className={`w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03] ${dim}`}
      />
    </div>
  )
}

function DishCard({
  item,
  index,
  qty,
  onAdjust,
}: {
  item: MenuItem
  index: number
  qty: number
  onAdjust: (delta: number) => void
}) {
  const muted = !item.available
  return (
    <motion.article
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{
        layout: SPRING_GENTLE,
        opacity: { duration: 0.24, delay: Math.min(index * 0.035, 0.22), ease: EASE_EDITORIAL },
        y: { duration: 0.28, delay: Math.min(index * 0.035, 0.22), ease: EASE_EDITORIAL },
      }}
      aria-disabled={muted || undefined}
      className={`group ${
        muted ? 'bg-paper' : 'bg-receipt hover:border-stone/45'
      } border border-hairline rounded-card p-5 flex items-center gap-5 transition-colors`}
    >
      <DishImage item={item} />
      <div className="flex-1 min-w-0 flex flex-col justify-between gap-3 self-stretch">
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2
              className={`font-display font-semibold text-base tracking-tight truncate ${
                muted ? 'text-stone' : 'text-espresso'
              }`}
            >
              {item.name}
            </h2>
            <span
              className={`font-display font-semibold text-base tracking-tight tabular-nums shrink-0 ${
                muted ? 'text-stone' : 'text-espresso'
              }`}
            >
              {formatShortPrice(item.priceCents)}
            </span>
          </div>
          <p className="font-body text-sm text-stone line-clamp-2">{item.description}</p>
        </div>
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="font-mono text-xs uppercase text-stone tabular-nums">
            {`${item.prepMinutes} MIN · ${item.category.toUpperCase()}`}
          </span>
          <div className="shrink-0">
            {muted ? (
              <span className="font-mono text-xs uppercase text-stone">AGOTADO</span>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                {qty > 0 ? (
                  <motion.div
                    key="stepper"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={SPRING_SNAPPY}
                  >
                    <Stepper qty={qty} label={item.name} onChange={onAdjust} variant="dark" />
                  </motion.div>
                ) : (
                  <motion.button
                    key="add"
                    type="button"
                    onClick={() => onAdjust(1)}
                    whileTap={{ scale: 0.95 }}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={SPRING_SNAPPY}
                    className="px-3.5 py-1.5 rounded-card border border-hairline hover:border-espresso font-display font-semibold text-xs tracking-tight text-espresso transition-colors"
                  >
                    + Agregar
                  </motion.button>
                )}
              </AnimatePresence>
            )}
          </div>
        </div>
      </div>
    </motion.article>
  )
}

function MenuSkeleton() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, delay: i * 0.04, ease: EASE_EDITORIAL }}
          className="bg-receipt border border-hairline rounded-card p-5 flex items-center gap-5"
        >
          <Skeleton className="w-24 h-24 shrink-0 rounded-md border border-hairline/70" />
          <div className="flex-1 min-w-0 flex flex-col justify-between gap-3 self-stretch">
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-3">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-4 w-12" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
            <div className="flex items-center justify-between gap-3 pt-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-20 rounded-card" />
            </div>
          </div>
        </motion.div>
      ))}
    </>
  )
}

function LiveOrderSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-1.5">
        <Skeleton className="h-1 w-full rounded-none" />
        <Skeleton className="h-1 w-full rounded-none" />
        <Skeleton className="h-1 w-full rounded-none" />
      </div>
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-12" />
      </div>
      <Skeleton className="h-3 w-44 mt-1" />
    </div>
  )
}

function LiveOrderStatus({
  orders,
  ordersLoading,
  studentName,
}: {
  orders: Order[]
  ordersLoading: boolean
  studentName: string
}) {
  const activeOrder = useMemo(() => {
    const active = orders
      .filter((o) => o.status !== 'delivered' && o.status !== 'cancelled')
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    const needle = studentName.trim().toLowerCase()
    const mine = needle ? active.find((o) => o.studentName.trim().toLowerCase() === needle) : undefined
    return mine ?? active[0] ?? null
  }, [orders, studentName])

  const currentStep = activeOrder ? STATUS_STEPS.findIndex((s) => s.key === activeOrder.status) : -1

  return (
    <div className="border-t border-hairline p-8 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase text-stone">Estado del Pedido en Vivo</span>
        {activeOrder ? (
          <motion.span
            key={activeOrder.orderCode}
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: EASE_EDITORIAL }}
            className="font-mono text-xs uppercase text-espresso tabular-nums"
          >
            #{activeOrder.orderCode}
          </motion.span>
        ) : ordersLoading && orders.length === 0 ? (
          <Skeleton className="h-3.5 w-16" />
        ) : null}
      </div>

      {ordersLoading && orders.length === 0 ? (
        <LiveOrderSkeleton />
      ) : activeOrder ? (
        <motion.div
          key={`${activeOrder.id}-${activeOrder.status}`}
          initial={{ opacity: 0.65 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25, ease: EASE_EDITORIAL }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-3 gap-1.5">
              {STATUS_STEPS.map((step, i) => {
                const done = i < currentStep
                const current = i === currentStep
                const fill = done
                  ? 'bg-espresso'
                  : current
                    ? step.key === 'ready'
                      ? 'bg-live-green'
                      : 'bg-vermilion'
                    : 'bg-transparent'
                return (
                  <div key={step.key} className="h-0.5 bg-hairline overflow-hidden">
                    <motion.div
                      className={`h-full origin-left ${fill}`}
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: done || current ? 1 : 0 }}
                      transition={{ duration: 0.45, ease: EASE_EDITORIAL, delay: current ? 0.08 : 0 }}
                    />
                  </div>
                )
              })}
            </div>
            <div className="grid grid-cols-3 font-mono text-xs uppercase">
              {STATUS_STEPS.map((step, i) => (
                <span
                  key={step.key}
                  className={`transition-colors ${i === 1 ? 'text-center' : i === 2 ? 'text-right' : ''} ${
                    i === currentStep
                      ? step.key === 'ready'
                        ? 'text-live-green font-semibold'
                        : 'text-espresso font-semibold'
                      : 'text-stone'
                  }`}
                >
                  {step.label}
                </span>
              ))}
            </div>
          </div>
          <span className="font-mono text-xs uppercase text-stone tabular-nums">
            ACTUALIZADO {formatClockTime(activeOrder.updatedAt)} · {activeOrder.studentName.toUpperCase()}
          </span>
        </motion.div>
      ) : (
        <p className="font-body text-sm text-stone">Sin pedidos activos todavía.</p>
      )}
    </div>
  )
}

export function StudentView({
  menuItems,
  orders,
  ordersLoading,
  studentName,
  onStudentNameChange,
  onOrderCreated,
  menuLoading,
  menuError,
  onRetryMenu,
}: StudentViewProps) {
  const [category, setCategory] = useState<CategoryFilter>('Todas')
  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<Record<number, number>>({})
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<SubmitError | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    return menuItems.filter((item) => {
      if (category !== 'Todas' && item.category !== category) return false
      if (!q) return true
      return item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
    })
  }, [menuItems, category, search])

  const cartLines = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, qty]) => ({ item: menuItems.find((m) => m.id === Number(id)), qty }))
        .filter((l): l is { item: MenuItem; qty: number } => !!l.item && l.qty > 0),
    [cart, menuItems],
  )

  const itemCount = cartLines.reduce((sum, l) => sum + l.qty, 0)
  const subtotalCents = cartLines.reduce((sum, l) => sum + l.qty * l.item.priceCents, 0)
  const canSubmit = itemCount > 0 && studentName.trim().length > 0 && !submitting

  function adjust(id: number, delta: number) {
    setSubmitError(null)
    setCart((prev) => {
      const next = { ...prev }
      const qty = (next[id] ?? 0) + delta
      if (qty <= 0) delete next[id]
      else next[id] = Math.min(qty, 20)
      return next
    })
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setSubmitError(null)
    setConfirmation(null)
    try {
      const trimmedNotes = notes.trim()
      const result = await createOrder({
        studentName: studentName.trim(),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
        items: cartLines.map((l) => ({ menuItemId: l.item.id, quantity: l.qty })),
      })
      setConfirmation({
        orderCode: result.order.orderCode,
        correlationId: result.correlationId ?? result.order.correlationId,
        eventPublished: result.eventPublished,
      })
      setCart({})
      setNotes('')
      onOrderCreated(result.order, result.eventPublished)
    } catch (err) {
      setSubmitError(describeOrderError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const showSkeleton = menuLoading && menuItems.length === 0

  return (
    <div className="flex-1 max-w-[1440px] w-full mx-auto grid grid-cols-1 lg:grid-cols-[68fr_32fr]">
      {/* Left: editorial menu */}
      <section
        className={`px-6 sm:px-8 pt-10 flex flex-col gap-8 ${itemCount > 0 ? 'pb-24 lg:pb-10' : 'pb-10'}`}
        aria-labelledby="student-menu-title"
      >
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: EASE_EDITORIAL }}
          className="flex flex-col sm:flex-row sm:items-end justify-between gap-6"
        >
          <h1 id="student-menu-title" className="font-display font-bold text-3xl tracking-tight text-espresso">
            Menú de Hoy
          </h1>
          <label className="relative flex items-center w-full sm:w-64 border-b border-hairline focus-within:border-espresso transition-colors pb-1.5">
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
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar platillos..."
              aria-label="Buscar platillos"
              className="w-full bg-transparent border-0 p-0 text-sm text-espresso placeholder:text-stone focus:ring-0 focus:outline-none"
            />
          </label>
        </motion.div>

        <div
          className="flex flex-wrap items-center gap-6 border-b border-hairline pb-3"
          role="group"
          aria-label="Categorías del menú"
        >
          {FILTERS.map((f) => {
            const active = f === category
            return (
              <button
                key={f}
                type="button"
                onClick={() => setCategory(f)}
                aria-pressed={active}
                className={`relative pb-1 font-mono text-xs uppercase tracking-wider transition-colors ${
                  active ? 'text-espresso' : 'text-stone hover:text-espresso'
                }`}
              >
                {f}
                {active && (
                  <motion.span
                    layoutId="student-cat-underline"
                    className="absolute left-0 right-0 -bottom-[13px] h-0.5 bg-espresso"
                    transition={SPRING_SNAPPY}
                  />
                )}
              </button>
            )
          })}
        </div>

        <AnimatePresence>
          {menuError && (
            <motion.div
              role="alert"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2, ease: EASE_EDITORIAL }}
              className="bg-receipt border border-hairline border-l-2 border-l-offline-red rounded-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="flex flex-col gap-1">
                <span className="font-mono text-xs uppercase tracking-wider text-offline-red">
                  menu-service sin respuesta
                </span>
                <p className="font-body text-sm text-espresso">{menuError}</p>
                <p className="font-body text-sm text-stone">
                  El catálogo no está disponible. El resto de la app sigue funcionando.
                </p>
              </div>
              <motion.button
                type="button"
                whileTap={{ scale: 0.96 }}
                onClick={onRetryMenu}
                className="shrink-0 px-3.5 py-1.5 rounded-card border border-hairline hover:border-espresso font-display font-semibold text-xs tracking-tight text-espresso transition-colors"
              >
                Reintentar
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>

        <LayoutGroup id="menu-grid">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
            {showSkeleton ? (
              <MenuSkeleton />
            ) : (
              <AnimatePresence mode="popLayout" initial={false}>
                {visibleItems.map((item, i) => (
                  <DishCard
                    key={item.id}
                    item={item}
                    index={i}
                    qty={cart[item.id] ?? 0}
                    onAdjust={(d) => adjust(item.id, d)}
                  />
                ))}
              </AnimatePresence>
            )}
            {!showSkeleton && !menuError && visibleItems.length === 0 && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2 }}
                className="md:col-span-2 font-body text-sm text-stone py-6"
              >
                {menuItems.length === 0 ? 'El menú está vacío por ahora.' : 'Ningún platillo coincide con tu búsqueda.'}
              </motion.p>
            )}
          </div>
        </LayoutGroup>
      </section>

      {/* Right: sticky receipt rail */}
      <aside
        id="student-receipt"
        className="bg-receipt border-t lg:border-t-0 lg:border-l border-hairline lg:sticky lg:top-14 lg:h-[calc(100dvh-56px)] flex flex-col justify-between overflow-y-auto"
        aria-label="Tu pedido y estado en vivo"
      >
        <div className="p-8 flex flex-col gap-6">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display font-bold text-xl tracking-tight text-espresso">Tu Pedido</h2>
            <motion.span
              key={itemCount}
              initial={{ opacity: 0.5, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16 }}
              className="font-mono text-xs uppercase text-stone tabular-nums"
            >
              {itemCount} {itemCount === 1 ? 'ARTÍCULO' : 'ARTÍCULOS'}
            </motion.span>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-xs uppercase text-stone">Nombre del estudiante</span>
            <input
              type="text"
              value={studentName}
              onChange={(e) => onStudentNameChange(e.target.value)}
              placeholder="Ej. Ana García"
              autoComplete="name"
              className="w-full bg-transparent border-0 border-b border-hairline px-0 py-1.5 text-sm text-espresso placeholder:text-stone/60 focus:border-espresso focus:ring-0 focus:outline-none transition-colors"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-xs uppercase text-stone">Notas (opcional)</span>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Sin cebolla"
              maxLength={200}
              className="w-full bg-transparent border-0 border-b border-hairline px-0 py-1 text-sm text-espresso placeholder:text-stone/60 focus:border-espresso focus:ring-0 focus:outline-none transition-colors"
            />
          </label>

          <div className="flex flex-col gap-4 pt-2">
            {cartLines.length === 0 && (
              <p className="font-body text-sm text-stone py-2">Aún no agregas platillos.</p>
            )}
            <AnimatePresence initial={false}>
              {cartLines.map(({ item, qty }) => (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, height: 0, y: -4 }}
                  animate={{ opacity: 1, height: 'auto', y: 0 }}
                  exit={{ opacity: 0, height: 0, y: -4 }}
                  transition={{ duration: 0.22, ease: EASE_EDITORIAL }}
                  className="flex items-center justify-between gap-3 overflow-hidden"
                >
                  <div className="flex flex-col min-w-0">
                    <span className="font-display font-semibold text-sm tracking-tight text-espresso truncate">
                      {item.name}
                    </span>
                    <span className="font-mono text-xs text-stone tabular-nums">
                      {formatMXN(item.priceCents * qty)}
                    </span>
                  </div>
                  <Stepper qty={qty} label={item.name} onChange={(d) => adjust(item.id, d)} variant="outline" />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="border-t border-dotted border-hairline pt-4 flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm text-stone">
              <span>Subtotal</span>
              <span className="font-mono text-xs text-espresso tabular-nums">{formatMXN(subtotalCents)}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-stone">
              <span>Entrega</span>
              <span className="font-mono text-xs text-espresso">BARRA PRINCIPAL</span>
            </div>
            <div className="flex items-baseline justify-between pt-3 border-t border-dotted border-hairline">
              <span className="font-display font-bold text-base tracking-tight text-espresso">Total</span>
              <motion.span
                key={subtotalCents}
                initial={{ opacity: 0.6, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: EASE_EDITORIAL }}
                className="font-display font-bold text-xl tracking-tight text-espresso tabular-nums"
              >
                {formatMXN(subtotalCents)}
              </motion.span>
            </div>
          </div>

          <AnimatePresence mode="wait">
            {submitError && (
              <motion.div
                key="error"
                role="alert"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.2, ease: EASE_EDITORIAL }}
                className="border-l-2 border-offline-red pl-3 flex flex-col gap-1"
              >
                <span className="font-mono text-xs uppercase tracking-wider text-offline-red">{submitError.title}</span>
                <p className="font-body text-sm text-espresso">{submitError.message}</p>
                {submitError.correlationId && (
                  <span className="font-mono text-xs text-stone break-all">
                    correlationId: {submitError.correlationId}
                  </span>
                )}
              </motion.div>
            )}
            {!submitError && confirmation && (
              <motion.div
                key={`ok-${confirmation.orderCode}`}
                role="status"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.2, ease: EASE_EDITORIAL }}
                className="border-l-2 border-live-green pl-3 flex flex-col gap-1"
              >
                <span className="font-mono text-xs uppercase tracking-wider text-live-green">
                  Pedido #{confirmation.orderCode} recibido
                </span>
                <span className="font-mono text-xs text-stone break-all">
                  correlationId: {confirmation.correlationId}
                </span>
                {!confirmation.eventPublished && (
                  <p className="font-body text-sm text-stone">
                    Aviso: el broker (RabbitMQ) no está disponible; el pedido se guardó, pero la notificación
                    en vivo puede retrasarse.
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <motion.button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            whileTap={canSubmit ? { scale: 0.985 } : undefined}
            transition={SPRING_SNAPPY}
            className="w-full py-3.5 px-6 rounded-card bg-vermilion-cta hover:bg-vermilion-hover text-receipt font-display font-semibold text-sm tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion focus-visible:ring-offset-2 disabled:opacity-40 disabled:hover:bg-vermilion-cta disabled:cursor-not-allowed"
          >
            {submitting ? 'Enviando pedido…' : 'Hacer Pedido'}
          </motion.button>
          {!submitting && itemCount > 0 && !studentName.trim() && (
            <p className="-mt-3 font-mono text-xs uppercase text-stone">Escribe tu nombre para continuar</p>
          )}
        </div>

        <LiveOrderStatus orders={orders} ordersLoading={ordersLoading} studentName={studentName} />
      </aside>

      {/* Mobile floating cart bar */}
      <AnimatePresence>
        {itemCount > 0 && (
          <div key="mobile-cart" className="lg:hidden fixed bottom-4 inset-x-4 z-30">
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 20, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.97 }}
              whileTap={{ scale: 0.985 }}
              transition={SPRING_SNAPPY}
              onClick={() =>
                document.getElementById('student-receipt')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              aria-label={`Ver pedido: ${itemCount} ${itemCount === 1 ? 'artículo' : 'artículos'}, ${formatMXN(subtotalCents)}`}
              className="w-full bg-espresso text-receipt rounded-card px-5 py-3.5 flex items-center justify-between shadow-[0_12px_32px_-8px_rgba(22,20,18,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vermilion focus-visible:ring-offset-2"
            >
              <span className="flex flex-col items-start gap-0.5">
                <span className="font-mono text-xs uppercase text-receipt/70 tabular-nums">
                  {itemCount} {itemCount === 1 ? 'ARTÍCULO' : 'ARTÍCULOS'}
                </span>
                <motion.span
                  key={subtotalCents}
                  initial={{ opacity: 0.6, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: EASE_EDITORIAL }}
                  className="font-display font-bold text-base tracking-tight tabular-nums"
                >
                  {formatMXN(subtotalCents)}
                </motion.span>
              </span>
              <span className="font-display font-semibold text-xs tracking-tight text-receipt">Ver Pedido →</span>
            </motion.button>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}
