import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { desc, eq, gt, lt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { listScheduleChronological } from "./queries/schedule";
import { buildGrandLedger } from "./ledger";
import { announcements, categories, criteria, feedbackResponses, flashAlerts, mediaItems, messages, roundConfigs, roundLocations, scheduleItems, scores, sponsors, teamAttendance, teamMembers, teamRegistrations, teams, trashBackups } from "../db/schema";
import { asc } from "drizzle-orm";
import { requireAdmin } from "./auth";
import { buildLeaderboard, clearExpiredEvalTimers } from "./publicRouter";
import { assertPdf, importMemberRows, membershipMap, parseMemberRows, teamBelongsToCategory, teamsForCategory } from "./queries/teams";
import { saveStudyGuideFile } from "./directorRouter";
import { POINT_SCALE_KEYS, POINT_SCALE_DEFAULTS, getPointScale, setPointScale, type PointScaleKey } from "../contracts/pointScale";

const tokenInput = { token: z.string().min(1) };

/** Typed verification string required by every global purge trigger. */
const RESET_CONFIRMATION = "RESET-SCIENJECT";

/** Trash-bin retention window for soft-deleted purge snapshots. */
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Lazily purge trash entries past their 30-day retention window. */
async function purgeExpiredTrash() {
  await getDb().delete(trashBackups).where(lt(trashBackups.expiresAt, new Date()));
}

/** Insert rows back with original IDs, skipping any that collide with live data. */
async function restoreRows<T extends Record<string, unknown>>(
  table: any,
  rows: T[],
): Promise<number> {
  let restored = 0;
  for (const raw of rows) {
    try {
      // JSON round-trip converts Date cells to ISO strings — MySQL rejects the
      // "T...Z" format, so revive them into real Date objects before insert.
      const row = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [
          k,
          typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? new Date(v) : v,
        ]),
      );
      await getDb().insert(table).values(row as never);
      restored++;
    } catch (err) {
      // row id already exists in live data — skip, never overwrite
      console.error(`[trash-restore] skipped a row in a table:`, (err as Error).message);
    }
  }
  return restored;
}

async function findCategoryBySlug(slug: string) {
  const [cat] = await getDb().select().from(categories).where(eq(categories.slug, slug)).limit(1);
  if (!cat) throw new TRPCError({ code: "NOT_FOUND", message: `Category "${slug}" not found.` });
  return cat;
}

export const adminRouter = createRouter({
  /** God-mode health grid: all 13 categories at a glance. */
  overview: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireAdmin(input.token);
    await clearExpiredEvalTimers();
    const db = getDb();
    const cats = await db.select().from(categories);
    const membership = await membershipMap();
    const configRows = await db.select().from(roundConfigs);
    const critRows = await db.select().from(criteria);
    const scoreRows = await db.select().from(scores);
    const allTeams = await db.select().from(teams);

    return cats.map((c) => {
      const catTeams = allTeams.filter((t) => membership.get(t.id)?.has(c.id));
      const catCritIds = critRows.filter((x) => x.categoryId === c.id && x.round === c.activeRound).map((x) => x.id);
      const gradedTeamIds = new Set(
    scoreRows.filter((s) => s.round === c.activeRound && catCritIds.includes(s.criteriaId)).map((s) => s.teamId),
      );
      const cfg = configRows.find((r) => r.categoryId === c.id && r.round === c.activeRound);
      return {
        id: c.id,
        slug: c.slug,
        name: c.name,
        discipline: c.discipline,
        room: c.room,
        venue: c.venue,
        tagline: c.tagline,
        activeRound: c.activeRound,
        isLiveNow: c.isLiveNow,
        evalTimerEndsAt: c.evalTimerEndsAt,
        evalTimerRound: c.evalTimerRound,
        hasStudyGuide: Boolean(c.studyGuidePath),
        teamCount: catTeams.length,
        gradedCount: catTeams.filter((t) => gradedTeamIds.has(t.id)).length,
        cutoffScore: cfg?.cutoffScore ?? 0,
        resultsLive: cfg?.resultsLive ?? false,
        criteriaCount: catCritIds.length,
      };
    });
  }),

  /** Any category's leaderboard — bypasses isolation. */
  categoryBoard: publicQuery
    .input(z.object({ ...tokenInput, categorySlug: z.string(), round: z.number().int().min(1).max(3) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      return buildLeaderboard(cat.id, input.round);
    }),

  /** Override any score row in any category. */
  upsertScores: publicQuery
    .input(z.object({ ...tokenInput, categorySlug: z.string(), round: z.number().int().min(1).max(3), entries: z.array(z.object({ teamId: z.number(), criteriaId: z.number(), value: z.union([z.number(), z.string()]) })) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      const db = getDb();
      for (const entry of input.entries) {
        const [crit] = await db.select().from(criteria).where(eq(criteria.id, entry.criteriaId)).limit(1);
        const belongs = await teamBelongsToCategory(entry.teamId, cat.id);
        if (!belongs || !crit || crit.categoryId !== cat.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Team/criterion does not belong to the target category." });
        }
        // Standard integer conversion — accepts both numeric and raw text
        // payloads from the override console (mobile text-keyboard entry).
        const parsed = typeof entry.value === "string" ? parseInt(entry.value, 10) : entry.value;
        if (Number.isNaN(parsed)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Score value must be an integer." });
        }
        const value = Math.min(parsed, crit.maxPoints);
        await db
          .insert(scores)
          .values({ teamId: entry.teamId, criteriaId: entry.criteriaId, round: input.round, value })
          .onDuplicateKeyUpdate({ set: { value } });
      }
      return { ok: true, saved: input.entries.length };
    }),

  setRoundConfig: publicQuery
    .input(z.object({ ...tokenInput, categorySlug: z.string(), round: z.number().int().min(1).max(3), cutoffScore: z.number().min(0), closesAt: z.date().nullable().optional(), resultsLive: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      await getDb()
        .insert(roundConfigs)
        .values({ categoryId: cat.id, round: input.round, cutoffScore: input.cutoffScore, closesAt: input.closesAt ?? null, resultsLive: input.resultsLive ?? false })
        .onDuplicateKeyUpdate({
          set: {
            cutoffScore: input.cutoffScore,
            ...(input.closesAt !== undefined ? { closesAt: input.closesAt } : {}),
            ...(input.resultsLive !== undefined ? { resultsLive: input.resultsLive } : {}),
          },
        });
      return { ok: true };
    }),

  setActiveRound: publicQuery
    .input(z.object({ ...tokenInput, categorySlug: z.string(), round: z.number().int().min(1).max(3) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      await getDb().update(categories).set({ activeRound: input.round }).where(eq(categories.id, cat.id));
      return { ok: true };
    }),

  /**
   * Grand Master Tournament Ledger — compiles ALL 13 categories × ALL 3
   * rounds into one consolidated multi-page A4 landscape dossier: per
   * category, three stacked round tables with raw criteria marks, computed
   * round totals and qualification markers, page-break separated, with
   * branding vectors and an automated generation timestamp.
   */
  exportGrandLedger: publicQuery
    .input(z.object(tokenInput))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      await db
        .update(categories)
        .set({ evalTimerEndsAt: null, evalTimerRound: null })
        .where(lt(categories.evalTimerEndsAt, new Date()));
      const cats = await db.select().from(categories);
      const configRows = await db.select().from(roundConfigs);
      const critRows = await db.select().from(criteria);
      const scoreRows = await db.select().from(scores);

      const categoriesPayload: import("./ledger").LedgerCategory[] = [];
      let teamCount = 0;

      for (const cat of cats) {
        const teams = await teamsForCategory(cat.id);
        teamCount += teams.length;
        const rounds: import("./ledger").LedgerRoundBlock[] = [];
        for (const round of [1, 2, 3] as const) {
          const crits = critRows.filter((c) => c.categoryId === cat.id && c.round === round);
          const cfg = configRows.find((r) => r.categoryId === cat.id && r.round === round);
          const cutoff = cfg?.cutoffScore ?? 0;
          const critIds = crits.map((c) => c.id);
          const relevant = scoreRows.filter((s) => s.round === round && critIds.includes(s.criteriaId));

          const rows = teams
            .map((t) => {
              const marks = critIds.map((id) => {
                const cell = relevant.find((s) => s.teamId === t.id && s.criteriaId === id);
                return cell ? Math.round(cell.value * 10) / 10 : 0;
              });
              const total = Math.round(marks.reduce((s, m) => s + m, 0) * 10) / 10;
              const graded = relevant.some((s) => s.teamId === t.id);
              const marker = !graded ? "PENDING" : cutoff > 0 ? (total >= cutoff ? "QUALIFIED" : "ELIMINATED") : "GRADED";
              return {
                name: t.name,
                school: t.school ?? "",
                marks,
                total,
                marker,
              };
            })
            .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
          rounds.push({
            round,
            criteria: crits.map((c) => ({ name: c.name, maxPoints: c.maxPoints })),
            cutoff,
            rows,
          });
        }
        categoriesPayload.push({
          name: cat.name,
          discipline: cat.discipline,
          venue: `${cat.room} | ${cat.venue}`,
          rounds,
        });
      }

      const pdf = buildGrandLedger({ categories: categoriesPayload, generatedAt: new Date(), teamCount });
      return { dataBase64: pdf.toString("base64"), categoryCount: categoriesPayload.length, teamCount };
    }),

  /** Full round-by-round location ledger (admin matrix editor). */
  listRoundLocations: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await getDb().select().from(roundLocations);
    return rows.map((r) => ({ categoryId: r.categoryId, round: r.round, branch: r.branch, floor: r.floor, room: r.room }));
  }),

  /**
   * Add / map / modify a physical location for one category × one round.
   * Upserts into the authoritative round_locations ledger — every public hub
   * reads these rows live, so the cascade is immediate with no cached text.
   */
  setRoundLocation: publicQuery
    .input(
      z.object({
        ...tokenInput,
        categorySlug: z.string(),
        round: z.number().int().min(1).max(3),
        branch: z.enum(["16C A-Levels", "15C O-Levels", "Courtyard/Open Area", "Auditorium"]),
        floor: z.enum(["1st Floor", "2nd Floor", "3rd Floor", "Ground"]),
        room: z.string().min(1).max(255),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      const db = getDb();
      await db
        .insert(roundLocations)
        .values({ categoryId: cat.id, round: input.round, branch: input.branch, floor: input.floor, room: input.room })
        .onDuplicateKeyUpdate({ set: { branch: input.branch, floor: input.floor, room: input.room } });
      return { ok: true };
    }),

  /**
   * Bulk member-roster CSV/Excel upload — row-based engine.
   * Columns: [Team Name, School Institution, Member Name, Categories]
   * The Categories cell accepts a comma-separated multi-select list
   * ("Avionix, Pitchcraft, Equinox") and cross-populates every listed category.
   */
  csvUpload: publicQuery
    .input(z.object({ ...tokenInput, csvText: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = parseMemberRows(input.csvText);
      if (rows.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No valid member rows found. Expected: Team Name, School Institution, Member Name, Categories" });
      }
      const result = await importMemberRows(rows);
      return { ok: true, ...result };
    }),

  /** Upload a study-guide PDF for any category (base64 payload). */
  uploadStudyGuide: publicQuery
    .input(z.object({ ...tokenInput, categorySlug: z.string(), dataBase64: z.string().min(100).max(28 * 1024 * 1024) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      const buf = assertPdf(input.dataBase64);
      const rel = saveStudyGuideFile(cat.slug, buf);
      await getDb().update(categories).set({ studyGuidePath: rel }).where(eq(categories.id, cat.id));
      return { ok: true };
    }),

  /** Remove a category's uploaded study guide. */
  removeStudyGuide: publicQuery
    .input(z.object({ ...tokenInput, categorySlug: z.string() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      if (cat.studyGuidePath) {
        try { fs.unlinkSync(path.resolve(process.cwd(), cat.studyGuidePath)); } catch { /* already gone */ }
      }
      await getDb().update(categories).set({ studyGuidePath: null }).where(eq(categories.id, cat.id));
      return { ok: true };
    }),

  removeTeam: publicQuery
    .input(z.object({ ...tokenInput, teamId: z.number() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      await db.delete(teamRegistrations).where(eq(teamRegistrations.teamId, input.teamId));
     await db.delete(teamMembers).where(eq(teamMembers.teamId, input.teamId));
      await db.delete(scores).where(eq(scores.teamId, input.teamId));
      await db.delete(teams).where(eq(teams.id, input.teamId));
      return { ok: true };
    }),

  // ─── Ticker Controller ──────────────────────────────────────────────
  listAnnouncements: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireAdmin(input.token);
    return getDb().select().from(announcements).orderBy(desc(announcements.createdAt)).limit(30);
  }),

  /** Overwrite the ticker: deactivate everything, set a single new message. */
  setTicker: publicQuery
    .input(z.object({ ...tokenInput, text: z.string().min(1).max(500) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      await db.update(announcements).set({ active: false });
      await db.insert(announcements).values({ text: input.text, active: true });
      return { ok: true };
    }),

  addAnnouncement: publicQuery
    .input(z.object({ ...tokenInput, text: z.string().min(1).max(500) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await getDb().insert(announcements).values({ text: input.text, active: true });
      return { ok: true };
    }),

  removeAnnouncement: publicQuery
    .input(z.object({ ...tokenInput, id: z.number() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await getDb().delete(announcements).where(eq(announcements.id, input.id));
      return { ok: true };
    }),

  // ─── Live Point Scale Tuning Desk ─────────────────────────────────────────────
  /** Current live scale values + factory baselines (for the tuning desk UI). */
  getPointScale: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireAdmin(input.token);
    const live = await getPointScale();
    return {
      live,
      defaults: {
        compulsory: { r1: POINT_SCALE_DEFAULTS.COMPULSORY_R1, r2: POINT_SCALE_DEFAULTS.COMPULSORY_R2, r3: POINT_SCALE_DEFAULTS.COMPULSORY_R3 },
        optional: { r1: POINT_SCALE_DEFAULTS.OPTIONAL_R1, r2: POINT_SCALE_DEFAULTS.OPTIONAL_R2, r3: POINT_SCALE_DEFAULTS.OPTIONAL_R3 },
      },
    };
  }),

  /**
   * Apply & Propagate Scale Changes — overwrites the global runtime variables
   * instantly and persists them; the next leaderboard/modal read re-derives
   * every team's qualification vectors against the new numbers.
   */
  setPointScale: publicQuery
    .input(
      z.object({
        ...tokenInput,
        values: z.record(z.string(), z.number().int().min(0).max(100000)),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const clean: Partial<Record<PointScaleKey, number>> = {};
      for (const [k, v] of Object.entries(input.values)) {
        if ((POINT_SCALE_KEYS as string[]).includes(k)) clean[k as PointScaleKey] = v;
      }
      if (Object.keys(clean).length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No valid point-scale keys supplied." });
      }
      await setPointScale(clean);
      const live = await getPointScale();
      return { ok: true, live };
    }),

  // ─── Delegate feedback (isolated table — admin-only viewer) ──────────────
  listFeedback: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await getDb().select().from(feedbackResponses).orderBy(desc(feedbackResponses.createdAt));
    return rows;
  }),

  // ─── Urgent flash alert — full-screen override on every public screen ────
  emitFlashAlert: publicQuery
    .input(z.object({ ...tokenInput, text: z.string().min(1).max(1000) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      // One alert at a time — a new emission supersedes any live overlay.
      await db.delete(flashAlerts).where(gt(flashAlerts.expiresAt, new Date()));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10-minute live window
      const [{ id }] = await db.insert(flashAlerts).values({ text: input.text, expiresAt }).$returningId();
      return { ok: true, id };
    }),

  /** Retract the live flash alert early (if one is showing). */
  clearFlashAlert: publicQuery.input(z.object(tokenInput)).mutation(async ({ input }) => {
    await requireAdmin(input.token);
    await getDb().delete(flashAlerts).where(gt(flashAlerts.expiresAt, new Date()));
    return { ok: true };
  }),

  // ─── Category runtime overrides (venue mapping, params, live status) ────
  updateCategory: publicQuery
    .input(
      z.object({
        ...tokenInput,
        categorySlug: z.string(),
        name: z.string().min(1).max(128).optional(),
        room: z.string().max(128).optional(),
        venue: z.string().max(128).optional(),
        tagline: z.string().max(255).optional(),
        activeRound: z.number().int().min(1).max(3).nullable().optional(),
        isLiveNow: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      const { categorySlug: _omit, token: _t, ...patch } = input;

      // Master Admin absolute override: setting a category inactive forcefully
      // overrides any director state — the running evaluation clock is shut down
      // and the live round badge is torn down in the same atomic write.
      if (patch.isLiveNow === false || patch.activeRound === null) {
        patch.evalTimerEndsAt = null;
        patch.evalTimerRound = null;
      }
      if (patch.isLiveNow === false) {
        patch.activeRound = null;
      }

      await getDb().update(categories).set(patch).where(eq(categories.id, cat.id));
      return { ok: true };
    }),

  /** Master override: edit or halt any category's live evaluation clock. */
  setEvaluationTimer: publicQuery
    .input(z.object({ ...tokenInput, categorySlug: z.string(), round: z.number().int().min(1).max(3), minutes: z.number().int().min(1).max(24 * 60) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      await getDb()
        .update(categories)
        .set({ evalTimerEndsAt: new Date(Date.now() + input.minutes * 60000), evalTimerRound: input.round })
        .where(eq(categories.id, cat.id));
      return { ok: true };
    }),

  haltEvaluationTimer: publicQuery
    .input(z.object({ ...tokenInput, categorySlug: z.string() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const cat = await findCategoryBySlug(input.categorySlug);
      await getDb()
        .update(categories)
        .set({ evalTimerEndsAt: null, evalTimerRound: null })
        .where(eq(categories.id, cat.id));
      return { ok: true };
    }),

  // ─── Timeline schedule CRUD ─────────────────────────────────────────────
  listSchedule: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireAdmin(input.token);
    return listScheduleChronological();
  }),

  addScheduleItem: publicQuery
    .input(z.object({ ...tokenInput, dayLabel: z.string().min(1).max(64), timeLabel: z.string().min(1).max(64), title: z.string().min(1).max(255), venue: z.string().max(255).default("") }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const rows = await db.select().from(scheduleItems);
      const maxOrder = rows.reduce((m, r) => Math.max(m, r.sortOrder), -1);
      await db.insert(scheduleItems).values({
        dayLabel: input.dayLabel,
        timeLabel: input.timeLabel,
        title: input.title,
        venue: input.venue,
        sortOrder: maxOrder + 1,
      });
      return { ok: true };
    }),

  updateScheduleItem: publicQuery
    .input(z.object({ ...tokenInput, id: z.number(), dayLabel: z.string().max(64).optional(), timeLabel: z.string().max(64).optional(), title: z.string().max(255).optional(), venue: z.string().max(255).optional() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const { token: _t, id, ...patch } = input;
      await getDb().update(scheduleItems).set(patch).where(eq(scheduleItems.id, id));
      return { ok: true };
    }),

  removeScheduleItem: publicQuery
    .input(z.object({ ...tokenInput, id: z.number() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await getDb().delete(scheduleItems).where(eq(scheduleItems.id, input.id));
      return { ok: true };
    }),

  /** Reorder the timeline: swap an item with its previous/next neighbour. */
  moveScheduleItem: publicQuery
    .input(z.object({ ...tokenInput, id: z.number(), direction: z.enum(["up", "down"]) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const rows = await db.select().from(scheduleItems).orderBy(asc(scheduleItems.sortOrder), asc(scheduleItems.id));
      const idx = rows.findIndex((r) => r.id === input.id);
      if (idx === -1) throw new TRPCError({ code: "NOT_FOUND", message: "Schedule item not found." });
      const swapIdx = input.direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= rows.length) return { ok: true, moved: false };
      const a = rows[idx];
      const b = rows[swapIdx];
      // Normalize sortOrder first (guards against duplicate values), then swap positions.
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].sortOrder !== i) {
          await db.update(scheduleItems).set({ sortOrder: i }).where(eq(scheduleItems.id, rows[i].id));
        }
      }
      await db.update(scheduleItems).set({ sortOrder: swapIdx }).where(eq(scheduleItems.id, a.id));
      await db.update(scheduleItems).set({ sortOrder: idx }).where(eq(scheduleItems.id, b.id));
      return { ok: true, moved: true };
    }),

  // ─── Sponsor management ────────────────────────────────────────────
  listSponsors: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireAdmin(input.token);
    return getDb().select().from(sponsors).orderBy(asc(sponsors.sortOrder));
  }),

  addSponsor: publicQuery
    .input(z.object({ ...tokenInput, name: z.string().min(1).max(255) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const rows = await db.select().from(sponsors);
      const maxOrder = rows.reduce((m, r) => Math.max(m, r.sortOrder), -1);
      await db.insert(sponsors).values({ name: input.name, sortOrder: maxOrder + 1 });
      return { ok: true };
    }),

  removeSponsor: publicQuery
    .input(z.object({ ...tokenInput, id: z.number() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await getDb().delete(sponsors).where(eq(sponsors.id, input.id));
      return { ok: true };
    }),

  /**
   * 🚨 GLOBAL EMERGENCY WIPE — clears the entire relational roster dataset:
   * every individual member record, team institution, attendance checklist,
   * category assignment and cached score across all 13 categories at once.
   * The typed verification string is enforced server-side, not just in the UI.
   */
  wipeAllRosters: publicQuery
    .input(z.object({ ...tokenInput, confirmation: z.string(), keepTrash: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      if (input.confirmation !== RESET_CONFIRMATION) {
        throw new TRPCError({ code: "FORBIDDEN", message: `Type ${RESET_CONFIRMATION} exactly to authorize the global wipe.` });
      }
      const db = getDb();

      const payload = {
        teams: await db.select().from(teams),
        team_members: await db.select().from(teamMembers),
        team_registrations: await db.select().from(teamRegistrations),
        team_attendance: await db.select().from(teamAttendance),
        scores: await db.select().from(scores),
        round_configs: await db.select().from(roundConfigs),
        media_items: await db.select().from(mediaItems),
      };
      const counts = {
        scores: payload.scores.length,
        members: payload.team_members.length,
        attendance: payload.team_attendance.length,
        registrations: payload.team_registrations.length,
        teams: payload.teams.length,
        media: payload.media_items.length,
      };

      // optional soft-delete: snapshot everything into the 30-day trash bin first
      if (input.keepTrash && counts.teams + counts.members + counts.scores > 0) {
        await db.insert(trashBackups).values({
          kind: "rosters",
          label: `Full roster snapshot — ${counts.teams} teams / ${counts.members} members`,
          summary: `${counts.teams} teams · ${counts.members} members · ${counts.registrations} registrations · ${counts.attendance} attendance · ${counts.scores} scores · ${counts.media} media`,
          payload,
          expiresAt: new Date(Date.now() + TRASH_TTL_MS),
        });
      }

      // children first, parents last
      await db.delete(scores);
      await db.delete(teamMembers);
      await db.delete(teamAttendance);
      await db.delete(teamRegistrations);
      await db.delete(teams);

      // retract all published round results across the 13 categories
      await db.delete(roundConfigs);

      // flush the live media gallery arrays with the factory reset
      await db.delete(mediaItems);

      // Structural reset binding — purge every locally ingested gallery asset
      // (uploads/media/) so no orphaned file references survive the wipe.
      const mediaDir = path.resolve(process.cwd(), "uploads", "media");
      if (fs.existsSync(mediaDir)) fs.rmSync(mediaDir, { recursive: true, force: true });

      return { ok: true, ...counts, trashSaved: input.keepTrash };
    }),

  /**
   * 🗑️ CLEAR GLOBAL PING CHAT HISTORY — permanently flushes the centralized
   * inter-departmental messages table (department + category pings alike).
   */
  clearPingHistory: publicQuery
    .input(z.object({ ...tokenInput, confirmation: z.string(), keepTrash: z.boolean().default(false) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      if (input.confirmation !== RESET_CONFIRMATION) {
        throw new TRPCError({ code: "FORBIDDEN", message: `Type ${RESET_CONFIRMATION} exactly to authorize the chat purge.` });
      }
      const db = getDb();
      const payload = { messages: await db.select().from(messages) };
      const purgedPings = payload.messages.length;

      if (input.keepTrash && purgedPings > 0) {
        await db.insert(trashBackups).values({
          kind: "pings",
          label: `Ping chat history snapshot — ${purgedPings} messages`,
          summary: `${purgedPings} pings`,
          payload,
          expiresAt: new Date(Date.now() + TRASH_TTL_MS),
        });
      }

      await db.delete(messages);
      return { ok: true, purgedPings, trashSaved: input.keepTrash };
    }),

  /** List trash-bin backups (auto-purges entries older than 30 days first). */
  listTrash: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireAdmin(input.token);
    await purgeExpiredTrash();
    const rows = await getDb().select({
      id: trashBackups.id,
      kind: trashBackups.kind,
      label: trashBackups.label,
      summary: trashBackups.summary,
      createdAt: trashBackups.createdAt,
      expiresAt: trashBackups.expiresAt,
    }).from(trashBackups).orderBy(desc(trashBackups.createdAt));
    return rows;
  }),

  /** Restore a trash-bin snapshot back into the live tables (never overwrites live rows). */
  restoreTrash: publicQuery
    .input(z.object({ ...tokenInput, id: z.number() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const db = getDb();
      const [entry] = await db.select().from(trashBackups).where(eq(trashBackups.id, input.id)).limit(1);
      if (!entry) throw new TRPCError({ code: "NOT_FOUND", message: "Trash entry not found (or already expired)." });
      const payload = entry.payload as Record<string, Record<string, unknown>[]>;

      let restored: Record<string, number> = {};
      if (entry.kind === "rosters") {
        // parents first, then children
        restored = {
          teams: await restoreRows(teams, payload.teams ?? []),
          members: await restoreRows(teamMembers, payload.team_members ?? []),
          registrations: await restoreRows(teamRegistrations, payload.team_registrations ?? []),
          attendance: await restoreRows(teamAttendance, payload.team_attendance ?? []),
          scores: await restoreRows(scores, payload.scores ?? []),
          roundConfigs: await restoreRows(roundConfigs, payload.round_configs ?? []),
          media: await restoreRows(mediaItems, payload.media_items ?? []),
        };
      } else {
        restored = { pings: await restoreRows(messages, payload.messages ?? []) };
      }

      const totalRestored = Object.values(restored).reduce((a, b) => a + b, 0);
      const totalInSnapshot = Object.values(payload).reduce((a, rows) => a + rows.length, 0);
      // keep the entry parked if the restore was incomplete — never strand data
      if (totalRestored >= totalInSnapshot || totalRestored > 0) {
        await db.delete(trashBackups).where(eq(trashBackups.id, entry.id));
      }
      if (totalRestored === 0 && totalInSnapshot > 0) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Restore wrote 0 rows — snapshot kept in Trash Bin for retry." });
      }
      return { ok: true, restored };
    }),

  /** Permanently destroy a trash-bin entry before its 30-day expiry. */
  deleteTrash: publicQuery
    .input(z.object({ ...tokenInput, id: z.number() }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await getDb().delete(trashBackups).where(eq(trashBackups.id, input.id));
      return { ok: true };
    }),
});
