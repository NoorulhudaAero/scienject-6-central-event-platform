import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { eq, lt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { buildGrandLedger } from "./ledger";
import { categories, criteria, roundConfigs, roundLocations, scores, teamMembers, teamRegistrations, teams } from "../db/schema";
import { requireAdmin } from "./auth";
import { buildLeaderboard, clearExpiredEvalTimers } from "./publicRouter";
import { assertPdf, importMemberRows, membershipMap, parseMemberRows, teamBelongsToCategory, teamsForCategory } from "./queries/teams";
import { saveStudyGuideFile } from "./directorRouter";
import { findCategoryBySlug } from "./adminRouterShared";

export const adminProcsA = {
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

};
