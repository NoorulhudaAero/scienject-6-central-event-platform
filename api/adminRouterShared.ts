import { z } from "zod";
import { eq, lt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./queries/connection";
import { categories, trashBackups } from "../db/schema";

export const tokenInput = { token: z.string().min(1) };

/** Typed verification string required by every global purge trigger. */
export const RESET_CONFIRMATION = "RESET-SCIENJECT";

/** Trash-bin retention window for soft-deleted purge snapshots. */
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Lazily purge trash entries past their 30-day retention window. */
export async function purgeExpiredTrash() {
  await getDb().delete(trashBackups).where(lt(trashBackups.expiresAt, new Date()));
}

/** Insert rows back with original IDs, skipping any that collide with live data. */
export async function restoreRows<T extends Record<string, unknown>>(
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

export async function findCategoryBySlug(slug: string) {
  const [cat] = await getDb().select().from(categories).where(eq(categories.slug, slug)).limit(1);
  if (!cat) throw new TRPCError({ code: "NOT_FOUND", message: `Category "${slug}" not found.` });
  return cat;
}