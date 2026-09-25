import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { sessions } from "../db/schema";
import { createSession, resolveSession, verifyAdminKey, verifyDepartmentLogin, verifyDirectorLogin } from "./auth";

export const authRouter = createRouter({
  /** Director login: category + secret alphanumeric PIN → isolated session token. */
  loginDirector: publicQuery
    .input(z.object({ categorySlug: z.string(), pin: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const category = await verifyDirectorLogin(input.categorySlug, input.pin);
      const token = await createSession("director", category.id);
      return {
        token,
        role: "director" as const,
        category: { id: category.id, slug: category.slug, name: category.name },
      };
    }),

  /** Master Admin login: master secret key → god-mode session token. */
  loginAdmin: publicQuery
    .input(z.object({ masterKey: z.string().min(1) }))
    .mutation(async ({ input }) => {
      verifyAdminKey(input.masterKey);
      const token = await createSession("admin", null);
      return { token, role: "admin" as const };
    }),

  /** Department head login: department + secret PIN → department session token. */
  loginDepartment: publicQuery
    .input(z.object({ departmentSlug: z.string(), pin: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const department = await verifyDepartmentLogin(input.departmentSlug, input.pin);
      const token = await createSession("department", null, department.slug);
      return {
        token,
        role: "department" as const,
        department: { slug: department.slug, name: department.name },
      };
    }),

  /** Validate an existing token (route guards + floating control badge). */
  validate: publicQuery
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const session = await resolveSession(input.token);
      let categoryName: string | null = null;
      let departmentName: string | null = null;
      const db = getDb();
      if (session.role === "director" && session.categoryId != null) {
        const { categories } = await import("../db/schema");
        const [cat] = await db.select().from(categories).where(eq(categories.id, sessi
on.categoryId)).limit(1);
        categoryName = cat?.name ?? null;
      }
      if (session.role === "department" && session.allocationSlug) {
        const { departments } = await import("../db/schema");
        const [dept] = await db.select().from(departments).where(eq(departments.slug, session.allocationSlug)).limit(1);
        departmentName = dept?.name ?? null;
      }
      return { role: session.role, categoryId: session.categoryId, categoryName, departmentName };
    }),

  logout: publicQuery
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input }) => {
      await getDb().delete(sessions).where(eq(sessions.token, input.token));
      return { ok: true };
    }),
});
