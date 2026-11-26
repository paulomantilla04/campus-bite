import { basename } from "node:path";
import { and, count, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { db, dbPath, sqlite } from "./db";
import { CATEGORIES, menuItems } from "./db/schema";

type Env = { Variables: { correlationId: string } };

const app = new Hono<Env>();
const startedAt = Date.now();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "X-Correlation-Id"],
    exposeHeaders: ["X-Correlation-Id"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.use("*", async (c, next) => {
  const correlationId = c.req.header("x-correlation-id") ?? `corr-${crypto.randomUUID().slice(0, 8)}`;
  c.set("correlationId", correlationId);
  const start = performance.now();
  await next();
  c.header("X-Correlation-Id", correlationId);
  const ms = (performance.now() - start).toFixed(1);
  console.log(`[menu-service] ${c.req.method} ${c.req.path} ${c.res.status} (${ms}ms) corr=${correlationId}`);
});

const idParam = z.coerce.number().int().positive();

const createSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  category: z.enum(CATEGORIES),
  priceCents: z.number().int().positive(),
  available: z.boolean().optional(),
  prepMinutes: z.number().int().positive().optional(),
  emoji: z.string().trim().min(1).optional(),
  imageUrl: z.string().trim().min(1).nullable().optional(),
});

const updateSchema = createSchema.partial().refine((v) => Object.keys(v).length > 0, {
  message: "At least one field must be provided",
});

const validateSchema = z.object({
  items: z
    .array(
      z.object({
        menuItemId: z.number().int().positive(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
});

const listQuerySchema = z.object({
  category: z.enum(CATEGORIES).optional(),
  available: z.enum(["true", "false"]).optional(),
  search: z.string().trim().optional(),
});

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function findItem(id: number) {
  return db.select().from(menuItems).where(eq(menuItems.id, id)).get();
}

app.get("/health", (c) => {
  try {
    sqlite.query("SELECT 1").get();
    const [row] = db.select({ n: count() }).from(menuItems).all();
    return c.json({
      service: "menu-service",
      status: "healthy",
      database: { engine: "sqlite", file: basename(dbPath), status: "ok", itemCount: row?.n ?? 0 },
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return c.json(
      {
        service: "menu-service",
        status: "unhealthy",
        database: { engine: "sqlite", file: basename(dbPath), status: "error", error: String(err) },
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
});

app.get("/items", (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters", details: parsed.error.flatten() }, 400);
  }
  const { category, available, search } = parsed.data;
  const filters: SQL[] = [];
  if (category) filters.push(eq(menuItems.category, category));
  if (available) filters.push(eq(menuItems.available, available === "true"));
  if (search) {
    const pattern = `%${search.toLowerCase()}%`;
    filters.push(
      or(like(sql`lower(${menuItems.name})`, pattern), like(sql`lower(${menuItems.description})`, pattern))!,
    );
  }
  const items = db
    .select()
    .from(menuItems)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(menuItems.id)
    .all();
  return c.json({ items });
});

app.post("/items/validate", async (c) => {
  const parsed = validateSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ valid: false, error: "Invalid request body", details: parsed.error.flatten() }, 400);
  }
  const requested = parsed.data.items;
  const ids = [...new Set(requested.map((i) => i.menuItemId))];
  const found = new Map(
    db.select().from(menuItems).where(inArray(menuItems.id, ids)).all().map((item) => [item.id, item]),
  );

  const errors: { menuItemId: number; reason: "not_found" | "unavailable"; message: string }[] = [];
  for (const { menuItemId } of requested) {
    const item = found.get(menuItemId);
    if (!item) {
      errors.push({ menuItemId, reason: "not_found", message: `Menu item ${menuItemId} does not exist` });
    } else if (!item.available) {
      errors.push({ menuItemId, reason: "unavailable", message: `${item.name} is currently unavailable` });
    }
  }
  if (errors.length > 0) {
    return c.json({ valid: false, errors }, 400);
  }

  const items = requested.map(({ menuItemId, quantity }) => {
    const item = found.get(menuItemId)!;
    return {
      menuItemId,
      name: item.name,
      unitPriceCents: item.priceCents,
      quantity,
      lineTotalCents: item.priceCents * quantity,
    };
  });
  const totalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);
  return c.json({ valid: true, items, totalCents });
});

app.get("/items/:id", (c) => {
  const id = idParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Menu item not found" }, 404);
  const item = findItem(id.data);
  if (!item) return c.json({ error: "Menu item not found" }, 404);
  return c.json({ item });
});

app.post("/items", async (c) => {
  const parsed = createSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
  }
  const item = db
    .insert(menuItems)
    .values({ ...parsed.data, createdAt: new Date().toISOString() })
    .returning()
    .get();
  return c.json({ item }, 201);
});

app.patch("/items/:id", async (c) => {
  const id = idParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Menu item not found" }, 404);
  const parsed = updateSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.flatten() }, 400);
  }
  const item = db.update(menuItems).set(parsed.data).where(eq(menuItems.id, id.data)).returning().get();
  if (!item) return c.json({ error: "Menu item not found" }, 404);
  return c.json({ item });
});

app.delete("/items/:id", (c) => {
  const id = idParam.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Menu item not found" }, 404);
  const deleted = db.delete(menuItems).where(eq(menuItems.id, id.data)).returning({ id: menuItems.id }).get();
  if (!deleted) return c.json({ error: "Menu item not found" }, 404);
  return c.json({ deleted: true, id: deleted.id });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(`[menu-service] error corr=${c.get("correlationId")}`, err);
  return c.json({ error: "Internal server error" }, 500);
});

const port = Number(process.env.PORT ?? 3001);
console.log(`[menu-service] listening on http://localhost:${port} (db: ${dbPath})`);

export default { port, fetch: app.fetch };
