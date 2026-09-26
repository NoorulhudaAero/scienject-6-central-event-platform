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

// ────── Categories (13 hardcoded event categories) ──────
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

// ────── Teams ──────
export const teams = mysqlTable(
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

// ────── Team ↔ Category registrations (many-to-many) ──────
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

// ────── Individual team members (row-based roster engine) ──────
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

// ────── Dynamic scoring criteria (per category, per round) ──────
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

// ────── Per-round configuration: cutoff score + evaluation window close ──────
export const roundConfigs = mysqlTable(
  "round_configs",
  {
    id: serial("id").primaryKey(),
    categoryId: bigint("categoryId", { mode: "number", unsigned: true }).notNull(),
    round: int("round").notNull(),
    cutoffScore: double("cutoffScore").notNull().default(0),
    closesAt: timestamp("closesAt"),
    resultsLive: boolean("resultsLive").notNull().default(false),
  },
  (table) => ({
    uniqueCategoryRound: unique("round_configs_category_round_unique").on(table.categoryId, table.round),
  }),
);

// ────── Round-by-round physical location ledger ──────
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

// ────── Individual criterion scores ──────
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

// ────── Live announcements (ticker) ──────
export const announcements = mysqlTable("announcements", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// ────── Departments (support staff) ──────
export const departments = mysqlTable("departments", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  pinHash: varchar("pinHash", { length: 128 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

// ────── Master timeline schedule items (admin-editable) ──────
export const scheduleItems = mysqlTable("schedule_items", {
  id: serial("id").primaryKey(),
  dayLabel: varchar("dayLabel", { length: 64 }).notNull(),
  timeLabel: varchar("timeLabel", { length: 64 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  venue: varchar("venue", { length: 255 }).notNull().default(""),
  sortOrder: int("sortOrder").notNull().default(0),
});

// ────── Sponsors (dynamic carousel) ──────
export const sponsors = mysqlTable("sponsors", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  sortOrder: int("sortOrder").notNull().default(0),
});

// ────── Helpdesk pings (directors ↔ departments ↔ admin) ──────
export const messages = mysqlTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    senderRole: mysqlEnum("senderRole", ["director", "department", "admin"]).notNull(),
    senderName: varchar("senderName", { length: 255 }).notNull(),
    toDepartment: varchar("toDepartment", { length: 64 }).notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => ({
    deptIdx: index("messages_dept_idx").on(table.toDepartment),
  }),
);

// ────── Attendance checklist (Day 1–3) ──────
export const teamAttendance = mysqlTable(
  "team_attendance",
  {
    id: serial("id").primaryKey(),
    teamId: bigint("teamId", { mode: "number", unsigned: true }).notNull(),
    day: int("day").notNull(),
    present: boolean("present").notNull().default(false),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    uniqueTeamDay: unique("attendance_team_day_unique").on(table.teamId, table.day),
  }),
);

// ────── Auth sessions (director PIN / department PIN / master admin key) ──────
export const sessions = mysqlTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    token: varchar("token", { length: 128 }).notNull().unique(),
    role: mysqlEnum("role", ["director", "admin", "department"]).notNull(),
    categoryId: bigint("categoryId", { mode: "number", unsigned: true }),
    allocationSlug: varchar("allocationSlug", { length: 64 }),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (table) => ({
    tokenIdx: index("sessions_token_idx").on(table.token),
  }),
);

// ────── Trash bin (soft-delete backups from global purge actions, 30-day TTL) ──────
export const trashBackups = mysqlTable("trash_backups", {
  id: serial("id").primaryKey(),
  kind: mysqlEnum("kind", ["rosters", "pings"]).notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  payload: json("payload").notNull(), // full row snapshot of every affected table
  summary: varchar("summary", { length: 255 }).notNull().default(""),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  expiresAt: timestamp("expiresAt").notNull(), // createdAt + 30 days
});

export type Category = typeof categories.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type TeamMember = typeof teamMembers.$inferSelect;
export type TeamRegistration = typeof teamRegistrations.$inferSelect;
export type Criterion = typeof criteria.$inferSelect;
export type RoundConfig = typeof roundConfigs.$inferSelect;
export type Score = typeof scores.$inferSelect;
export type Announcement = typeof announcements.$inferSelect;
export type Department = typeof departments.$inferSelect;
export type ScheduleItem = typeof scheduleItems.$inferSelect;
export type Sponsor = typeof sponsors.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type TeamAttendance = typeof teamAttendance.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type TrashBackup = typeof trashBackups.$inferSelect;

// ────── Delegate feedback (isolated — viewable exclusively in /admin) ──────
export const feedbackResponses = mysqlTable("feedback_responses", {
  id: serial("id").primaryKey(),
  delegateName: varchar("delegateName", { length: 255 }).notNull(),
  school: varchar("school", { length: 255 }),
  role: varchar("role", { length: 64 }).notNull().default("Delegate"),
  overallRating: int("overallRating").notNull(), // 1–5
  organizationRating: int("organizationRating").notNull(), // 1–5
  venueRating: int("venueRating").notNull(), // 1–5
  judgingRating: int("judgingRating").notNull(), // 1–5
  favoriteCategory: varchar("favoriteCategory", { length: 255 }),
  highlights: text("highlights"),
  improvements: text("improvements"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export type FeedbackResponse = typeof feedbackResponses.$inferSelect;

// ────── Urgent flash alerts (admin → every public screen) ──────
export const flashAlerts = mysqlTable("flash_alerts", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  expiresAt: timestamp("expiresAt").notNull(), // short-lived overlay window
  dismissed: int("dismissed").notNull().default(0), // ack counter
});

export type FlashAlert = typeof flashAlerts.$inferSelect;

// ────── Media gallery (public /media grid + Media department uploads) ──────
export const mediaItems = mysqlTable("media_items", {
  id: serial("id").primaryKey(),
  kind: mysqlEnum("kind", ["photo", "video"]).notNull().default("photo"),
  url: varchar("url", { length: 1000 }).notNull(), // external link or /uploads/media/… path
  title: varchar("title", { length: 255 }).notNull().default(""),
  dayTag: varchar("dayTag", { length: 16 }).notNull().default("day1"), // promo | opening | day1 | day2 | day3 | closing
  orientation: varchar("orientation", { length: 12 }).notNull().default("landscape"), // vertical | landscape
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export type MediaItem = typeof mediaItems.$inferSelect;

// ────── Live point-scale settings (Master Admin tuning desk overrides) ──────
export const pointScaleSettings = mysqlTable("point_scale_settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 32 }).notNull().unique(), // COMPULSORY_R1 …
  value: int("value").notNull(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
});

export type PointScaleSetting = typeof pointScaleSettings.$inferSelect;
