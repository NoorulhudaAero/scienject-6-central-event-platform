import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { desc, eq, asc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { listScheduleChronological } from "./queries/schedule";
import { categories, mediaItems, messages, roundConfigs, scheduleItems, scores, sponsors, teamAttendance, teamMembers, teamRegistrations, teams, trashBackups } from "../db/schema";
import { requireAdmin } from "./auth";
import { RESET_CONFIRMATION, TRASH_TTL_MS, purgeExpiredTrash, restoreRows, findCategoryBySlug } from "./adminRouterShared";

export const adminProcsC = {
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

  // ─── Timeline schedule CRUD ─────────────────────
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

  // ─── Sponsor management ─────────────────────────
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
};
