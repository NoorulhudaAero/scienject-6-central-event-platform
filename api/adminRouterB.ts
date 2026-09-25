import { z } from "zod";
import { desc, eq, gt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { announcements, categories, feedbackResponses, flashAlerts } from "../db/schema";
import { requireAdmin } from "./auth";
import { POINT_SCALE_KEYS, POINT_SCALE_DEFAULTS, getPointScale, setPointScale } from "../contracts/pointScale";
import { findCategoryBySlug } from "./adminRouterShared";

export const adminProcsB = {
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

  // ─── Live Point Scale Tuning Desk ─────────────────
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

  // ─── Delegate feedback (isolated table — admin-only viewer) ──────────
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
};
