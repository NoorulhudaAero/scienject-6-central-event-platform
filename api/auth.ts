import { createHash, randomBytes } from "crypto";
import { eq, gt, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./queries/connection";
import { sessions, categories, departments } from "../db/schema";

// Master Admin Secret Key — server-side only, never shipped to the client bundle.
const MASTER_ADMIN_KEY = "SCIENJECT-MASTER-GOLD-6X0";

export const hashPin = (pin: string) =>
  createHash("sha256").update(pin.trim().toUpperCase()).digest("hex");

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — persistent sessions until manual logout

export async function createSession(
  role: "director" | "admin" | "department",
  categoryId: number | null,
  allocationSlug: string | null = null,
) {
  const token = randomBytes(32).toString("hex");
  await getDb().insert(sessions).values({
    token,
    role,
    categoryId,
    allocationSlug,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export interface ResolvedSession {
  token: string;
  role: "director" | "admin" | "department";
  categoryId: number | null;
  allocationSlug: string | null;
}

export async function resolveSession(token: string | undefined): Promise<ResolvedSession> {
  if (!token) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing session token. Please sign in." });
  }
  const db = getDb();
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Session expired or invalid. Please sign in again." });
  }
  return {
    token: session.token,
    role: session.role,
    categoryId: session.categoryId ?? null,
    allocationSlug: session.allocationSlug ?? null,
  };
}

/** Director guard — session MUST be a director and locked to its own category. */
export async function requireDirector(token: string | undefined) {
  const session = await resolveSession(token);
  if (session.role !== "director" || session.categoryId == null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Director credentials required for this action." });
  }
  return session as ResolvedSession & { categoryId: number };
}

/** Admin guard — bypasses all category isolation. */
export async function requireAdmin(token: string | undefined) {
  const session = await resolveSession(token);
  if (session.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Master Admin credentials required for this action." });
  }
  return session;
}

/** Department guard — session MUST be a department head with a valid allocation. */
export async function requireDepartment(token: string | undefined) {
  const session = await resolveSession(token);
  if (session.role !== "department" || !session.allocationSlug) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Department credentials required for this action." });
  }
  return session as ResolvedSession & { allocationSlug: string };
}

export async function verifyDepartmentLogin(slug: string, pin: string) {
  const db = getDb();
  const [department] = await db.select().from(departments).where(eq(departments.slug, slug)).limit(1);
  if (!department || department.pinHash !== hashPin(pin)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid department or Secret PIN." });
  }
  return department;
}

export async function verifyDirectorLogin(slug: string, pin: string) {
  const db = getDb();
  const [category] = await db.select().from(categories).where(eq(categories.slug, cat.slug)).limit(1);
  if (!category || category.pinHash !== hashPin(pin)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid category or Secret PIN." });
  }
  return category;
}

export function verifyAdminKey(key: string) {
  if (key.trim() !== MASTER_ADMIN_KEY) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid Master Admin Secret Key." });
  }
}
