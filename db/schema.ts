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
e(
  "teams",
  {
    id: serial("id").primaryKey(),
    categoryId: bigint("categoryId", { mode: "number", unsigned: true }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    school: varchar("school", { length: 255 }),
    memberNames: text("memberNames"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => ({
    categoryIdx: index("teams_category_idx").on(table.categoryId),
  }),
);

// ─── Team ↔ Category registrations (many-to-many) ─────────────────────────
// A single team entity can register for multiple categories simultaneously.
// teams.categoryId remains the "primary" category for legacy compatibility;
// this join table is the authoritative source for category membership.
export const teamRegistrations = mysqlTable(
  "team_registrations",
  {
    id: serial("id").primaryKey(),
    teamId: bigint("teamId", { mode: "number", unsigned: true }).notNull(),
    categoryId: bigint("categoryId", { mode: "number", unsigned: true }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => ({
    uniqueTeamCategory: unique("team_registrations_team_category_unique").on(table.teamId, table.categoryId),
    categoryIdx: index("team_registrations_category_idx").on(table.categoryId),
    teamIdx: index("team_registrations_team_idx").on(table.teamId),
  }),
);

// ─── Individual team members (row-based roster engine) ─────────────────────────
// One row per student. The CSV/Excel import pipeline ingests rows of
// [Team Name, School Institution, Member Name, Categories] and lands each
// student here, cross-populated into every category their team registered for.
export const teamMembers = mysqlTable(
  "team_members",
  {
    id: serial("id").primaryKey(),
    teamId: bigint("teamId", { mode: "number", unsigned: true }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => ({
    teamIdx: index("team_members_team_idx").on(table.teamId),
    uniqueTeamMember: unique("team_members_team_name_unique").on(table.teamId, table.name),
  }),
);

// ─── Dynamic scoring criteria (per category, per round) ──────────────────────
export const criteria = mysqlTable(
  "criteria",
  {
    id: serial("id").primaryKey(),
    categoryId: bigint("categoryId", { mode: "number", unsigned: true }).notNull(),
    round: int("round").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    maxPoints: double("maxPoints").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => ({
    categoryRoundIdx: index("criteria_category_round_idx").on(table.categoryId, table.round),
  }),
);

// ─── Per-round configuration: cutoff score + evaluation window close ───────
export const roundConfigs = mysqlTable(
  "round_configs",
  {
    id: serial("id").primaryKey(),
    categoryId: bigint("categoryId", { mode: "number", unsigned: true }).notNull(
),
    round: int("round").notNull(),
    cutoffScore: double("cutoffScore").notNull().default(0),
    closesAt: timestamp("closesAt"),
    resultsLive: boolean("resultsLive").notNull().default(false),
  },
  (table) => ({
    uniqueCategoryRound: unique("round_configs_category_round_unique").on(table.categoryId, table.round),
  }),
);

// ─── Round-by-round physical location ledger ───────────────────────────────
// Authoritative room/branch/floor allocation per category per round. The flat
// categories.room / categories.venue strings are only the legacy fallback when
// no round row exists yet — every dashboard reads this table first.
export const roundLocations = mysqlTable(
  "round_locations",
  {
    id: serial("id").primaryKey(),
    categoryId: bigint("categoryId", { mode: "number", unsigned: true }).notNull(),
    round: int("round").notNull(),
    branch: varchar("branch", { length: 64 }).notNull(),
    floor: varchar("floor", { length: 64 }).notNull(),
    room: varchar("room", { length: 255 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqueCategoryRound: unique("round_locations_category_round_unique").on(table.categoryId, table.round),
    categoryIdx: index("round_locations_category_idx").on(table.categoryId),
  }),
);

// ─── Individual criterion scores ─────────────────────────────────────
─────────────────────────
export const scores = mysqlTable(
  "scores",
  {
    id: serial("id").primaryKey(),
    teamId: bigint("teamId", { mode: "number", unsigned: true }).notNull(),
    criteriaId: bigint("criteriaId", { mode: "number", unsigned: true }).notNull(),
    round: int("round").notNull(),
    value: double("value").notNull().default(0),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqueScore: unique("scores_team_criteria_round_unique").on(table.teamId, table.criteriaId, table.round),
    teamIdx: index("scores_team_idx").on(table.teamId),
  }),
);

// ─── Live announcements (ticker) ─────────────────────────────────────────────────────
export const announcements = mysqlTable("announcements", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// ─── Departments (support staff) ──────────────────────────────────────────────
export const departments = mysqlTable("departments", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  pinHash: varchar("pinHash", { length: 128 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// ─── Master timeline schedule items (admin-editable) ─────────────────────────
export const scheduleItems = mysqlTable("schedule_items", {
  id: serial("id").primaryKey(),
  dayLabel: varchar("dayLabel", { length: 64 }).notNull(),
  timeLabel: varchar("timeLabel", { length: 64 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  venue: varchar("venue", { length: 255 }).notNull().default(""),
  sortOrder: int("sortOrder").notNull().default(0),
});

// ─── Sponsors (dynamic carousel) ────────────────────────────────────────────────────────
export const sponsors = mysqlTable("sponsors", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  sortOrder: int("sortOrder").notNull().default(0),
});

// ─── Helpdesk pings (directors ↔ departments ↔ admin) ────────────────────────
e", { length: 128 }).notNull(),
  pinHash: varchar("pinHash", { length: 128 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// ─── Master timeline schedule items (admin-editable) ────────────────────────
export const scheduleItems = mysqlTable("schedule_items", {
  id: serial("id").primaryKey(),
  dayLabel: varchar("dayLabel", { length: 64 }).notNull(),
  timeLabel: varchar("timeLabel", { length: 64 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  venue: varchar("venue", { length: 255 }).notNull().default(""),
  sortOrder: int("sortOrder").notNull().default(0),
});

// ─── Sponsors (dynamic carousel) ──────────────────────────────────────────────────────────────
export const sponsors = mysqlTable("sponsors", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  sortOrder: int("sortOrder").notNull().default(0),
});

// ─── Helpdesk pings (directors ↔ departments ↔ admin) ────────────────────────
e