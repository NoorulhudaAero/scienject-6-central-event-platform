import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { categories, departments, mediaItems, scores, teamAttendance, teamMembers, teamRegistrations, teams } from "../db/schema";
import { importMemberRows, membersMap, membershipMap, parseMemberRows, registerTeamInCategory } from "./queries/teams";
import { requireDepartment } from "./auth";
import { buildPassportPdf } from "./passports";

const tokenInput = { token: z.string().min(1) };

const MEDIA_DAYS = z.enum(["promo", "opening", "day1", "day2", "day3", "closing"]);

/** Allowed local-upload containers and their canonical extensions. */
const MEDIA_UPLOAD_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** Gate: only the Media department may touch the gallery records. */
async function requireMedia(token: string) {
  const session = await requireDepartment(token);
  if (session.allocationSlug !== "media") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Media Department credentials required for gallery management." });
  }
  return session;
}

export const departmentRouter = createRouter({
  /** Department workspace header info. */
  workspace: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await requireDepartment(input.token);
    const db = getDb();
    const [dept] = await db.select().from(departments).where(eq(departments.slug, session.allocationSlug)).limit(1);
    const catRows = await db.select().from(categories);
    return {
      department: { slug: dept?.slug ?? session.allocationSlug, name: dept?.name ?? session.allocationSlug },
      categories: catRows.map((c) => ({ id: c.id, slug: c.slug, name: c.name })),
    };
  }),

  /** Full roster with attendance + multi-category registrations — the Registrations staff interface. */
  roster: publicQuery
    .input(z.object({ ...tokenInput, categoryId: z.number().optional() }))
    .query(async ({ input }) => {
      await requireDepartment(input.token);
      const db = getDb();
      const teamRows = await db.select().from(teams);
      const catRows = await db.select().from(categories);
      const attendanceRows = await db.select().from(teamAttendance);
      const membership = await membershipMap();
      const members = await membersMap();

      const catName = (id: number) => catRows.find((c) => c.id === id)?.name ?? "—";
      return teamRows
        .map((t) => {
          const catIds = [...(membership.get(t.id) ?? new Set([t.categoryId]))];
          const memberList = members.get(t.id) ?? [];
          return {
            id: t.id,
            name: t.name,
            school: t.school,
            memberNames: memberList.length ? memberList.join(", ") : t.memberNames,
            members: memberList,
            categoryIds: catIds,
            categories: catIds.map(catName).sort(),
            category: catIds.map(catName).sort().join(" · "),
            categoryId: t.categoryId,
            attendance: {
              day1: attendanceRows.find((a) => a.teamId === t.id && a.day === 1)?.present ?? false,
              day2: attendanceRows.find((a) => a.teamId === t.id && a.day === 2)?.present ?? false,
              day3: attendanceRows.find((a) => a.teamId === t.id && a.day === 3)?.present ?? false,
            },
          };
        })
        .filter((t) => (input.categoryId ? t.categoryIds.includes(input.categoryId) : true))
        .sort(
          (a, b) =>
            (a.school ?? "Independent Delegation").localeCompare(b.school ?? "Independent Delegation") ||
            a.name.localeCompare(b.name),
        );
    }),

  // ─── Media gallery management (Media department only) ───────────
  mediaList: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireMedia(input.token);
    const rows = await getDb().select().from(mediaItems).orderBy(desc(mediaItems.createdAt));
    return rows;
  }),

  mediaAdd: publicQuery
    .input(
      z.object({
        ...tokenInput,
        kind: z.enum(["photo", "video"]).default("photo"),
        url: z.string().max(1000).refine((u) => /^https?:\/\//.test(u) || u.startsWith("/uploads/"), "Provide a valid URL or an uploaded file path."),
        title: z.string().max(255).optional(),
        dayTag: MEDIA_DAYS,
        orientation: z.enum(["vertical", "landscape"]).default("landscape"),
      }),
    )
    .mutation(async ({ input }) => {
      await requireMedia(input.token);
      await getDb().insert(mediaItems).values({
        kind: input.kind,
        url: input.url,
        title: input.title ?? "",
        dayTag: input.dayTag,
        orientation: input.orientation,
      });
      return { ok: true };
    }),

  /**
   * Local file ingestion — accepts base64 image/video payloads from the Media
   * workspace (native device gallery or disk), persists them under
   * uploads/media/, and returns the servable /uploads/media/… path.
   */
  mediaUploadFile: publicQuery
    .input(
      z.object({
        ...tokenInput,
        fileName: z.string().max(255),
        mime: z.string().max(64),
        base64: z.string().max(46_000_000), // ≈32MB raw payload ceiling per file
      }),
    )
    .mutation(async ({ input }) => {
      await requireMedia(input.token);
      const mime = input.mime.toLowerCase();
      const ext = MEDIA_UPLOAD_MIME[mime];
      if (!ext) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Unsupported container — accepted: .png .jpeg .jpg .webp images, .mp4 .mov .webm videos.",
        });
      }
      const buf = Buffer.from(input.base64, "base64");
      if (!buf.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Empty file payload." });
      const safeName = input.fileName.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "media";
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const rel = `uploads/media/${stamp}-${safeName}.${ext}`;
      const fs = await import("node:fs");
      const path = await import("node:path");
      const abs = path.resolve(process.cwd(), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      return { ok: true, url: `/${rel}`, kind: mime.startsWith("video/") ? ("video" as const) : ("photo" as const) };
    }),

  mediaRemove: publicQuery
    .input(z.object({ ...tokenInput, id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await requireMedia(input.token);
      const db = getDb();
      const [row] = await getDb().select().from(mediaItems).where(eq(mediaItems.id, input.id)).limit(1);
      await db.delete(mediaItems).where(eq(mediaItems.id, input.id));
      // If the record referenced a locally ingested asset, purge the file too.
      if (row?.url.startsWith("/uploads/")) {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const abs = path.resolve(process.cwd(), row.url.replace(/^\/+/, ""));
        const root = path.resolve(process.cwd(), "uploads");
        if (abs.startsWith(root) && fs.existsSync(abs)) fs.rmSync(abs, { force: true });
      }
      return { ok: true };
    }),

  /**
   * Passport Batch Export — compile a multi-page check-in passport PDF for
   * every member profile on one team (one full page per student, QR bound to
   * the student's system ID). Returns base64 for instant client download.
   */
  exportPassports: publicQuery
    .input(z.object({ ...tokenInput, teamId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await requireDepartment(input.token);
      const db = getDb();
      const [team] = await db.select().from(teams).where(eq(teams.id, input.teamId)).limit(1);
      if (!team) throw new TRPCError({ code: "NOT_FOUND", message: "Team not found." });

      const memberRows = await db.select().from(teamMembers).where(eq(teamMembers.teamId, team.id));
      const members = (
        memberRows.length
          ? memberRows.map((m) => ({ memberId: m.id, memberName: m.name }))
          : // Legacy fallback — synthesize stable negative IDs from the free-text list.
            (team.memberNames ?? "")
              .split(/[,;\/|]/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((name, i) => ({ memberId: -(team.id * 100 + i + 1), memberName: name }))
      ).sort((a, b) => a.memberName.localeCompare(b.memberName));
      if (members.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This team has no member profiles to export." });
      }

      const catRows = await db.select().from(categories);
      const membership = await membershipMap();
      const catIds = [...(membership.get(team.id) ?? new Set([team.categoryId]))];
      const categoryNames = catIds
        .map((id) => catRows.find((c) => c.id === id)?.name ?? "")
        .filter(Boolean)
        .sort();

      const pdf = buildPassportPdf({
        teamName: team.name,
        school: team.school ?? "Independent Delegation",
        categories: categoryNames,
        members,
        verifiedAt: new Date(),
      });

      return {
        ok: true,
        fileName: `SCIENJECT6-Passports-${team.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`,
        pages: members.length,
        pdfBase64: pdf.toString("base64"),
      };
    }),

  /** Register one team into ONE OR MORE categories simultaneously. */
  addTeam: publicQuery
    .input(
      z.object({
        ...tokenInput,
        categoryIds: z.array(z.number()).min(1).max(13),
        name: z.string().min(1).max(255),
        school: z.string().max(255).optional(),
        memberNames: z.string().max(1000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireDepartment(input.token);
      const db = getDb();
      const [{ id }] = await db
        .insert(teams)
        .values({
          categoryId: input.categoryIds[0],
          name: input.name,
          school: input.school || null,
          memberNames: input.memberNames || null,
        })
        .$returningId();
      for (const categoryId of input.categoryIds) {
        await registerTeamInCategory(id, categoryId);
      }
      // Split the free-text member list into individual member rows
      const memberNames = (input.memberNames ?? "").split(/[,;\/|]/).map((s) => s.trim()).filter(Boolean);
      for (const name of memberNames) {
        try {
          await db.insert(teamMembers).values({ teamId: id, name });
        } catch { /* duplicate — skip */ }
      }
      return { ok: true, teamId: id };
    }),

  /**
   * Bulk Excel/CSV member-roster import — row-based engine.
   * Columns per row: [Team Name, School Institution, Member Name, Categories].
   * The Categories cell accepts a comma-separated multi-select list
   * (e.g. "Avionix, Pitchcraft, Equinox"); each member row is registered and
   * cross-populated into the director dashboards of every category listed.
   */
  bulkImport: publicQuery
    .input(z.object({ ...tokenInput, csvText: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await requireDepartment(input.token);
      const rows = parseMemberRows(input.csvText);
      if (rows.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No valid member rows found. Expected columns: Team Name, School Institution, Member Name, Categories",
        });
      }
      const result = await importMemberRows(rows);
      return { ok: true, ...result };
    }),

  /** Toggle a Day 1/2/3 attendance checkbox. */
  toggleAttendance: publicQuery
    .input(z.object({ ...tokenInput, teamId: z.number(), day: z.number().int().min(1).max(3), present: z.boolean() }))
    .mutation(async ({ input }) => {
      await requireDepartment(input.token);
      await getDb()
        .insert(teamAttendance)
        .values({ teamId: input.teamId, day: input.day, present: input.present })
        .onDuplicateKeyUpdate({ set: { present: input.present } });
      return { ok: true };
    }),

  removeTeam: publicQuery
    .input(z.object({ ...tokenInput, teamId: z.number() }))
    .mutation(async ({ input }) => {
      await requireDepartment(input.token);
      const db = getDb();
      await db.delete(teamAttendance).where(eq(teamAttendance.teamId, input.teamId));
      await db.delete(teamRegistrations).where(eq(teamRegistrations.teamId, input.teamId));
      await db.delete(teamMembers).where(eq(teamMembers.teamId, input.teamId));
      await db.delete(scores).where(eq(scores.teamId, input.teamId));
      await db.delete(teams).where(eq(teams.id, input.teamId));
      return { ok: true };
    }),
});
