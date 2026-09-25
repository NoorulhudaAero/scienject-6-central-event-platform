import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  text,
  timestamp,
  bigint,
  int,
  double,
  boolean,
  json,
  unique,
  index,
} from "drizzle-orm/mysql-core";

// ─── Categories (13 hardcoded event categories) ─────────────────────────────
export const categories = mysqlTable("categories", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  discipline: varchar("discipline", { length: 255 }).notNull().default(""),
  pinHash: varchar("pinHash", { length: 128 }).notNull(),
  room: varchar("room", { length: 128 }).notNull(),
  venue: varchar("venue", { length: 128 }).notNull(),
  tagline: varchar("tagline", { length: 255 }).notNull(),
  activeRound: int("activeRound"),
  isLiveNow: boolean("isLiveNow").notNull().default(false),
  evalTimerEndsAt: timestamp("evalTimerEndsAt"),
  evalTimerRound: int("evalTimerRound"),
  studyGuidePath: varchar("studyGuidePath", { length: 255 }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// ─── Teams ───────────────────────────────────────────────────
export const teams = mysqlTabl