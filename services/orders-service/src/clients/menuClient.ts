const MENU_SERVICE_URL = (process.env.MENU_SERVICE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
const MENU_TIMEOUT_MS = Number(process.env.MENU_TIMEOUT_MS ?? 3000);

export interface RequestedItem {
  menuItemId: number;
  quantity: number;
}

export interface ValidatedItem {
  menuItemId: number;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export type ValidateItemsResult =
  | { ok: true; items: ValidatedItem[]; totalCents: number }
  | { ok: false; kind: "validation"; status: 400; errors: unknown[] }
  | { ok: false; kind: "unavailable"; status: 503; message: string };

function unavailable(message: string): ValidateItemsResult {
  return { ok: false, kind: "unavailable", status: 503, message };
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `menu-service timed out after ${MENU_TIMEOUT_MS}ms`;
    }
    const code = (err as { code?: string }).code;
    if (code === "ECONNREFUSED" || code === "ConnectionRefused") {
      return `connection refused at ${MENU_SERVICE_URL}`;
    }
    return `${code ? `${code}: ` : ""}${err.message}`;
  }
  return String(err);
}

function toValidatedItem(raw: unknown, requested: RequestedItem | undefined): ValidatedItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const menuItemId = Number(r.menuItemId ?? r.id ?? requested?.menuItemId);
  const name = r.name ?? r.itemName;
  const unitPriceCents = Number(r.unitPriceCents ?? r.priceCents);
  const quantity = Number(r.quantity ?? requested?.quantity);
  if (!Number.isInteger(menuItemId) || typeof name !== "string") return null;
  if (!Number.isFinite(unitPriceCents) || !Number.isInteger(quantity)) return null;
  const lineTotalCents = Number(r.lineTotalCents ?? unitPriceCents * quantity);
  return { menuItemId, name, unitPriceCents, quantity, lineTotalCents };
}

export async function validateItems(items: RequestedItem[], correlationId: string): Promise<ValidateItemsResult> {
  let res: Response;
  try {
    res = await fetch(`${MENU_SERVICE_URL}/items/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Correlation-Id": correlationId },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(MENU_TIMEOUT_MS),
    });
  } catch (err) {
    return unavailable(describeFetchError(err));
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body; handled below
  }

  if (res.status >= 500) {
    return unavailable(`menu-service responded ${res.status}`);
  }

  if (res.status === 400 || res.status === 404 || res.status === 409 || res.status === 422) {
    const b = (body ?? {}) as Record<string, unknown>;
    const errors = Array.isArray(b.errors) ? b.errors : [b.error ?? b.message ?? `menu-service responded ${res.status}`];
    return { ok: false, kind: "validation", status: 400, errors };
  }

  if (!res.ok) {
    return unavailable(`menu-service responded ${res.status}`);
  }

  const b = (body ?? {}) as Record<string, unknown>;
  if (b.valid === false) {
    return { ok: false, kind: "validation", status: 400, errors: Array.isArray(b.errors) ? b.errors : [] };
  }
  if (!Array.isArray(b.items)) {
    return unavailable("menu-service returned an unexpected response shape");
  }

  const validated: ValidatedItem[] = [];
  for (const [i, raw] of b.items.entries()) {
    const item = toValidatedItem(raw, items[i]);
    if (!item) return unavailable("menu-service returned a malformed item");
    validated.push(item);
  }

  const totalCents =
    typeof b.totalCents === "number" ? b.totalCents : validated.reduce((sum, it) => sum + it.lineTotalCents, 0);

  return { ok: true, items: validated, totalCents };
}

export const menuClient = { validateItems };
