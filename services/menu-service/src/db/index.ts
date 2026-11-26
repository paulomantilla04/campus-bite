import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { menuItems, type NewMenuItem } from "./schema";

export const dbPath = process.env.DB_PATH ?? "./data/menu.db";

mkdirSync(dirname(dbPath), { recursive: true });

export const sqlite = new Database(dbPath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    available INTEGER NOT NULL DEFAULT 1,
    prep_minutes INTEGER NOT NULL DEFAULT 5,
    emoji TEXT NOT NULL DEFAULT '🍽️',
    image_url TEXT,
    created_at TEXT NOT NULL
  );
`);

// Ensure image_url exists if opening an older menu.db file
const columns = sqlite.query<{ name: string }, []>("PRAGMA table_info(menu_items)").all();
if (!columns.some((col) => col.name === "image_url")) {
  sqlite.exec("ALTER TABLE menu_items ADD COLUMN image_url TEXT;");
}

// Idempotent migration: point existing volumes at the optimized .webp images
sqlite.exec("UPDATE menu_items SET image_url = replace(image_url, '.jpeg', '.webp') WHERE image_url LIKE '/images/%.jpeg';");

export const db = drizzle(sqlite, { schema: { menuItems } });

const SEED: Omit<NewMenuItem, "createdAt">[] = [
  {
    name: "Chilaquiles Verdes",
    description: "Totopos crujientes bañados en salsa verde con crema, queso fresco y cebolla",
    category: "Desayunos",
    priceCents: 5000,
    prepMinutes: 8,
    emoji: "🌶️",
    imageUrl: "/images/chilaquiles-verdes.webp",
  },
  {
    name: "Enchiladas Suizas",
    description: "Tortillas rellenas de pollo con salsa cremosa verde y queso gratinado",
    category: "Desayunos",
    priceCents: 7500,
    prepMinutes: 10,
    emoji: "🫔",
    imageUrl: "/images/enchiladas-suizas.webp",
  },
  {
    name: "Molletes con chorizo",
    description: "Bolillo dorado con frijoles refritos, queso derretido, chorizo y pico de gallo",
    category: "Desayunos",
    priceCents: 6500,
    prepMinutes: 7,
    emoji: "🥖",
    imageUrl: "/images/molletes-chorizo.webp",
  },
  {
    name: "Empanadas de queso",
    description: "Orden de empanadas doradas rellenas de queso Oaxaca fundido",
    category: "Desayunos",
    priceCents: 5000,
    prepMinutes: 6,
    emoji: "🥟",
    imageUrl: "/images/empanadas.webp",
  },
  {
    name: "Chocomilk",
    description: "Leche fría batida con chocolate en polvo, bien espumoso",
    category: "Bebidas",
    priceCents: 2500,
    prepMinutes: 2,
    emoji: "🍫",
    imageUrl: "/images/chocomilk.webp",
  },
  {
    name: "Licuado de fresa",
    description: "Licuado natural de fresas frescas con leche fría",
    category: "Bebidas",
    priceCents: 3000,
    prepMinutes: 3,
    emoji: "🍓",
    imageUrl: "/images/licuado-fresa.webp",
  },
  {
    name: "Jugo de naranja",
    description: "Jugo 100% natural recién exprimido, vaso de 350 ml",
    category: "Bebidas",
    priceCents: 3500,
    prepMinutes: 2,
    emoji: "🍊",
    imageUrl: "/images/jugo-naranja.webp",
  },
  {
    name: "Hot cakes",
    description: "Torre de 3 hot cakes esponjosos con mantequilla y miel de maple",
    category: "Panadería",
    priceCents: 7500,
    prepMinutes: 8,
    emoji: "🥞",
    imageUrl: "/images/hotcakes.webp",
  },
  {
    name: "Croissant",
    description: "Croissant de mantequilla horneado al día, crujiente por fuera",
    category: "Panadería",
    priceCents: 4000,
    prepMinutes: 2,
    emoji: "🥐",
    imageUrl: "/images/croissant.webp",
  },
  {
    name: "Galleta",
    description: "Galleta recién horneada con chispas de chocolate semiamargo",
    category: "Panadería",
    priceCents: 2000,
    prepMinutes: 1,
    emoji: "🍪",
    imageUrl: "/images/galleta.webp",
  },
];

const [existing] = db.select({ n: count() }).from(menuItems).all();
if ((existing?.n ?? 0) === 0) {
  const now = new Date().toISOString();
  db.insert(menuItems).values(SEED.map((item) => ({ ...item, createdAt: now }))).run();
  console.log(`[menu-service] seeded ${SEED.length} menu items`);
}

export const MAX_MENU_ITEMS = 30;
const SEED_NAMES = SEED.map((item) => item.name);
const CUSTOM_ITEM_TTL_MS = 24 * 60 * 60 * 1000;

// Keeps the public demo usable: never fully sold out, and custom dishes expire after 24h
export function runDemoHygiene() {
  const placeholders = SEED_NAMES.map(() => "?").join(", ");
  const stats = sqlite
    .query<{ total: number; available: number | null }, []>(
      "SELECT count(*) AS total, sum(available) AS available FROM menu_items",
    )
    .get();
  if (stats && stats.total > 0 && (stats.available ?? 0) === 0) {
    const restored = sqlite
      .query(`UPDATE menu_items SET available = 1 WHERE name IN (${placeholders})`)
      .run(...SEED_NAMES);
    console.log(`[menu-service] demo hygiene: restored ${restored.changes} seeded items to available`);
  }
  const cutoff = new Date(Date.now() - CUSTOM_ITEM_TTL_MS).toISOString();
  const pruned = sqlite
    .query(`DELETE FROM menu_items WHERE name NOT IN (${placeholders}) AND created_at < ?`)
    .run(...SEED_NAMES, cutoff);
  if (pruned.changes > 0) {
    console.log(`[menu-service] demo hygiene: pruned ${pruned.changes} custom items older than 24h`);
  }
}
