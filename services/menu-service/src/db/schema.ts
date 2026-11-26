import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const CATEGORIES = ["Desayunos", "Bebidas", "Panadería"] as const;
export type Category = (typeof CATEGORIES)[number];

export const menuItems = sqliteTable("menu_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  category: text("category", { enum: CATEGORIES }).notNull(),
  priceCents: integer("price_cents").notNull(),
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  prepMinutes: integer("prep_minutes").notNull().default(5),
  emoji: text("emoji").notNull().default("🍽️"),
  imageUrl: text("image_url"),
  createdAt: text("created_at").notNull(),
});

export type MenuItem = typeof menuItems.$inferSelect;
export type NewMenuItem = typeof menuItems.$inferInsert;
