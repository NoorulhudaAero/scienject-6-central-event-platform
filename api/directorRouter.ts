import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import fs from "node:fs";
import path from "node:path";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { announcements, categories, criteria, roundConfigs, scores, teamAttendance, teamMembers, teamRegistrations, teams } from "../db/schema";
import { assertPdf, membersMap, registerTeamInCategory, teamBelongsToCategory, teamsForCategory, unregisterTeamFromCategory } from "./queries/teams";
import { requireDirector } from "./auth";
import { buildLeaderboard, clearExpiredEvalTimers } from "./publicRouter";

/** Persist an uploaded study-guide PDF under uploads/guides/<slug>.pdf. */
export function saveStudyGuideFile(slug: string, buf: Buffer) {
  const dir = path.resolve(process.cwd(), "uploads", "guides");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.pdf`);
  fs.writeFileSync(file, buf);
  return `uploads/guides/${slug}.pdf`;
}

const tokenInput = { token: z.string().min(1) };

async function assertTeamOwnership(teamId: number, categoryId: number) {
  const [team] = await getDb().select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team || !(await teamBelongsToCategory(teamId, categoryId))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Team does not belong to your category. Access denied." });
  }
  return team;
}

async function assertCriteriaOwnership(criteriaId: number, categoryId: number) {
  const [crit] = await getDb().select().from(criteria).where(eq(criteria.id, criteriaId)).limit(1);
  if (!crit || crit.categoryId !== categoryId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Criterion does not belong to your category. Access denied." });
  }
  return crit;
}

export const directorRouter = createRouter({
  /** Full director workspace for the session's own category. */
  dashboard: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await requireDirector(input.token);
    await clearExpiredEvalTimers();
    const db = getDb();
    const [category] = await db.select().from(categories).where(eq(categories.id, session.categoryId)).limit(1);
    // Cross-populated roster: every team registered for this category (multi-category aware),
    // grouped cleanly by institutional school origin.
    const teamRows = (await teamsForCategory(session.categoryId)).sort((a, b) =>
      (a.school ?? "Independent Delegation").localeCompare(b.school ?? "Independent Delegation") ||
      a.name.localeCompare(b.name),
    );
    const critRows = await db.select().from(criteria).where(eq(criteria.categoryId, session.categoryId));
    const configRows = await db.select().from(roundConfigs).where(eq(roundConfigs.categoryId, session.categoryId));
    const teamIds = teamRows.map((t) => t.id);
    const scoreRows = (await db.select().from(scores)).filter((s) => teamIds.includes(s.teamId));
    const members = await membersMap(teamIds);

    return {
      category: {
        id: category.id,
        slug: category.slug,
        name: category.name,
        discipline: category.discipline,
        room: category.room,
        venue: category.venue,
        tagline: category.tagline,
        activeRound: category.activeRound,
        isLiveNow: category.isLiveNow,
        evalTimerEndsAt: category.evalTimerEndsAt,
        evalTimerRound: category.evalTimerRound,
        hasStudyGuide: Boolean(category.studyGuidePath),
      },
      teams: teamRows.map((t) => ({ id: t.id, name: t.name, school: t.school, members: members.get(t.id) ?? [] })),
      criteria: critRows.map((c) => ({ id: c.id, round: c.round, name: c.name, maxPoints: c.maxPoints })),
      configs: [1, 2, 3].map((round) => {
        const c = configRows.find((r) => r.round === round);
        return { round, cutoffScore: c?.cutoffScore ?? 0, closesAt: c?.closesAt ?? null, resultsLive: c?.resultsLive ?? false };
      }),
      scores: scoreRows.map((s) => ({ teamId: s.teamId, criteriaId: s.criteriaId, round: s.round, value: s.value })),
    };
  }),

  addCriterion: publicQuery
    .input(z.object({ ...tokenInput, round: z.number().int().min(1).max(3), name: z.string().min(1).max(255), maxPoints: z.number().positive().max(10000) }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      await getDb().insert(criteria).values({ categoryId: session.categoryId, round: input.round, name: input.name, maxPoints: input.maxPoints });
      return { ok: true };
    }),

  deleteCriterion: publicQuery
    .input(z.object({ ...tokenInput, criteriaId: z.number() }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      await assertCriteriaOwnership(input.criteriaId, session.categoryId);
      const db = getDb();
      await db.delete(scores).where(eq(scores.criteriaId, input.criteriaId));
      await db.delete(criteria).where(eq(criteria.id, input.criteriaId));
      return { ok: true };
    }),

  setRoundConfig: publicQuery
    .input(z.object({ ...tokenInput, round: z.number().int().min(1).max(3), cutoffScore: z.number().min(0).max(9999), closesAt: z.date().nullable().optional() }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      const db = getDb();
      await db
        .insert(roundConfigs)
        .values({ categoryId: session.categoryId, round: input.round, cutoffScore: input.cutoffScore, closesAt: input.closesAt ?? null })
        .onDuplicateKeyUpdate({ set: { cutoffScore: input.cutoffScore, ...(input.closesAt !== undefined ? { closesAt: input.closesAt } : {}) } });
      return { ok: true };
    }),

  setActiveRound: publicQuery
    .input(z.object({ ...tokenInput, round: z.number().int().min(1).max(3) }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      await getDb().update(categories).set({ activeRound: input.round }).where(eq(categories.id, session.categoryId));
      return { ok: true };
    }),

  /** Take the currently active round down — clears the live badge platform-wide. */
  deactivateRound: publicQuery.input(z.object(tokenInput)).mutation(async ({ input }) => {
    const session = await requireDirector(input.token);
    await getDb()
      .update(categories)
      .set({ activeRound: null, evalTimerEndsAt: null, evalTimerRound: null })
      .where(eq(categories.id, session.categoryId));
    return { ok: true };
  }),

  /** Bulk score upsert — powers the 30s autosave marking grid. Strictly category-isolated. */
  upsertScores: publicQuery
    .input(z.object({ ...tokenInput, round: z.number().int().min(1).max(3), entries: z.array(z.object({ teamId: z.number(), criteriaId: z.number(), value: z.union([z.number(), z.string()]) })) }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      const db = getDb();
      for (const entry of input.entries) {
        await assertTeamOwnership(entry.teamId, session.categoryId);
        const crit = await assertCriteriaOwnership(entry.criteriaId, session.categoryId);
        if (crit.round !== input.round) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Criterion/round mismatch." });
        }
        // Standard integer conversion — accepts both numeric and raw text
        // payloads from the marking grid (mobile text-keyboard entry).
        const parsed = typeof entry.value === "string" ? parseInt(entry.value, 10) : entry.value;
        if (Number.isNaN(parsed)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Score value must be an integer." });
        }
        // Negative marking permitted — deductions may push the value below zero,
        // but never above the criterion's max.
        const value = Math.min(parsed, crit.maxPoints);
        await db
          .insert(scores)
          .values({ teamId: entry.teamId, criteriaId: entry.criteriaId, round: input.round, value })
          .onDuplicateKeyUpdate({ set: { value } });
      }
      return { ok: true, saved: input.entries.length };
    }),

  addTeam: publicQuery
    .input(z.object({ ...tokenInput, name: z.string().min(1).max(255), school: z.string().max(255).optional() }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      const db = getDb();
      const [{ id }] = await db
        .insert(teams)
        .values({ categoryId: session.categoryId, name: input.name, school: input.school ?? null })
        .$returningId();
      await registerTeamInCategory(id, session.categoryId);
      return { ok: true };
    }),

  /** Remove a team from THIS category. If it's their only registration, the entity is deleted. */
  removeTeam: publicQuery
    .input(z.object({ ...tokenInput, teamId: z.number() }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      await assertTeamOwnership(input.teamId, session.categoryId);
      const db = getDb();
      // Drop this category's scores for the team
      const catCritIds = (await db.select().from(criteria).where(eq(criteria.categoryId, session.categoryId))).map((c) => c.id);
      if (catCritIds.length) {
        const teamScoreRows = await db.select().from(scores).where(eq(scores.teamId, input.teamId));
        for (const s of teamScoreRows.filter((x) => catCritIds.includes(x.criteriaId))) {
          await db.delete(scores).where(eq(scores.id, s.id));
        }
      }
      const regs = await db.select().from(teamRegistrations).where(eq(teamRegistrations.teamId, input.teamId));
      const otherCats = new Set(regs.map((r) => r.categoryId).filter((c) => c !== session.categoryId));
      const [team] = await db.select().from(teams).where(eq(teams.id, input.teamId)).limit(1);
      if (team && team.categoryId !== session.categoryId) otherCats.add(team.categoryId);

      if (otherCats.size > 0) {
        // Multi-category team: only detach from this category
        await unregisterTeamFromCategory(input.teamId, session.categoryId);
        if (team && team.categoryId === session.categoryId) {
          const [newPrimary] = [...otherCats];
          await db.update(teams).set({ categoryId: newPrimary }).where(eq(teams.id, input.teamId));
        }
      } else {
        await db.delete(teamRegistrations).where(eq(teamRegistrations.teamId, input.teamId));
        await db.delete(teamMembers).where(eq(teamMembers.teamId, input.teamId));
        await db.delete(scores).where(eq(scores.teamId, input.teamId));
        await db.delete(teams).where(eq(teams.id, input.teamId));
      }
      return { ok: true };
    }),

  /** Mark results live for a round + push an announcement to the public ticker. */
  publishResults: publicQuery
    .input(z.object({ ...tokenInput, round: z.number().int().min(1).max(3) }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      const db = getDb();
      const [category] = await db.select().from(categories).where(eq(categories.id, session.categoryId)).limit(1);
      await db
        .insert(roundConfigs)
        .values({ categoryId: session.categoryId, round: input.round, resultsLive: true })
        .onDuplicateKeyUpdate({ set: { resultsLive: true } });
      await db.insert(announcements).values({
        text: `📢 ${category.name} Round ${input.round} results are now LIVE!`,
        active: true,
      });
      return { ok: true };
    }),

  /**
   * ⚠️ LOCAL ROSTER RESET — purges every team, member record, cached score and
   * dynamic criterion owned by THIS director's category only. Multi-category
   * teams registered elsewhere keep their other-category registrations; their
   * footprint inside this category is still fully removed. Other categories
   * are never touched.
   */
  purgeCategoryRoster: publicQuery
    .input(z.object(tokenInput))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      const db = getDb();
      const categoryId = session.categoryId;

      // snapshot counts for the confirmation toast
      const catCriteria = await db.select().from(criteria).where(eq(criteria.categoryId, categoryId));
      const catCritIds = catCriteria.map((c) => c.id);
      const catScores = catCritIds.length
        ? await db.select().from(scores).where(inArray(scores.criteriaId, catCritIds))
        : [];
      const catRegs = await db.select().from(teamRegistrations).where(eq(teamRegistrations.categoryId, categoryId));
      const legacyTeams = await db.select().from(teams).where(eq(teams.categoryId, categoryId));

      // wipe cached scores (linked through this category's criteria) + dynamic
      // criteria parameters + category assignments
      if (catCritIds.length) {
        await db.delete(scores).where(inArray(scores.criteriaId, catCritIds));
      }
      await db.delete(criteria).where(eq(criteria.categoryId, categoryId));
      await db.delete(teamRegistrations).where(eq(teamRegistrations.categoryId, categoryId));

      // fully drop only teams whose entire existence lived inside this category
      let purgedTeams = 0;
      let purgedMembers = 0;
      for (const t of legacyTeams) {
        const remaining = await db.select().from(teamRegistrations).where(eq(teamRegistrations.teamId, t.id)).limit(1);
        if (remaining.length === 0) {
          const members = await db.select().from(teamMembers).where(eq(teamMembers.teamId, t.id));
          purgedMembers += members.length;
          await db.delete(teamMembers).where(eq(teamMembers.teamId, t.id));
          await db.delete(teamAttendance).where(eq(teamAttendance.teamId, t.id));
          await db.delete(teams).where(eq(teams.id, t.id));
          purgedTeams++;
        }
      }

      // retract published round results so the dashboard returns to a clean grading state
      await db.delete(roundConfigs).where(eq(roundConfigs.categoryId, categoryId));

      return {
        ok: true,
        purgedTeams,
        purgedMembers,
        purgedCriteria: catCriteria.length,
        purgedScores: catScores.length,
        clearedAssignments: catRegs.length,
      };
    }),

  /** Start a precise round evaluation countdown visible on the public rankings view. */
  startEvaluationTimer: publicQuery
    .input(z.object({ ...tokenInput, round: z.number().int().min(1).max(3), minutes: z.number().int().min(1).max(24 * 60) }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      await getDb()
        .update(categories)
        .set({ evalTimerEndsAt: new Date(Date.now() + input.minutes * 60000), evalTimerRound: input.round })
        .where(eq(categories.id, session.categoryId));
      return { ok: true };
    }),

  haltEvaluationTimer: publicQuery
    .input(z.object(tokenInput))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      await getDb()
        .update(categories)
        .set({ evalTimerEndsAt: null, evalTimerRound: null })
        .where(eq(categories.id, session.categoryId));
      return { ok: true };
    }),

  /** Upload a study-guide PDF for the director's own category (base64 payload). */
  uploadStudyGuide: publicQuery
    .input(z.object({ ...tokenInput, dataBase64: z.string().min(100).max(28 * 1024 * 1024) }))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      const buf = assertPdf(input.dataBase64);
      const db = getDb();
      const [category] = await db.select().from(categories).where(eq(categories.id, session.categoryId)).limit(1);
      const rel = saveStudyGuideFile(category.slug, buf);
      await db.update(categories).set({ studyGuidePath: rel }).where(eq(categories.id, category.id));
      return { ok: true };
    }),

  /** Remove the uploaded study guide (public card falls back to "Coming Soon"). */
  removeStudyGuide: publicQuery
    .input(z.object(tokenInput))
    .mutation(async ({ input }) => {
      const session = await requireDirector(input.token);
      const db = getDb();
      const [category] = await db.select().from(categories).where(eq(categories.id, session.categoryId)).limit(1);
      if (category.studyGuidePath) {
        try { fs.unlinkSync(path.resolve(process.cwd(), category.studyGuidePath)); } catch { /* already gone */ }
      }
      await db.update(categories).set({ studyGuidePath: null }).where(eq(categories.id, category.id));
      return { ok: true };
    }),

  /** Director's own leaderboard view (isolated to own category). */
  leaderboard: publicQuery
    .input(z.object({ ...tokenInput, round: z.number().int().min(1).max(3) }))
    .query(async ({ input }) => {
      const session = await requireDirector(input.token);
      return buildLeaderboard(session.categoryId, input.round);
    }),
});
