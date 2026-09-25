import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { CATEGORIES } from "../contracts/categories";
import { buildStudyGuidePdf } from "./studyGuide";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 100 * 1024 * 1024 }));
// Locally ingested media assets (Media Department gallery uploads) — served
// straight from the persistent uploads/ directory.
app.get("/uploads/*", async (c) => {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const rel = decodeURIComponent(c.req.path.replace(/^\/+/, ""));
  const root = path.resolve(process.cwd(), "uploads");
  const file = path.resolve(process.cwd(), rel);
  if (!file.startsWith(root) || !fs.existsSync(file)) return c.json({ error: "Not Found" }, 404);
  const ext = path.extname(file).toLo
werCase();
  const mime =
    { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" }[ext] ??
    "application/octet-stream";
  return new Response(new Uint8Array(fs.readFileSync(file)), {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" },
  });
});
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
// Public study-guide PDF downloads — serves the director/admin-uploaded PDF when
// one is bound to the category, otherwise falls back to the placeholder series.
app.get("/api/study-guide/:slug", async (c) => {
  const cat = CATEGORIES.find((x) => x.slug === c.req.param("slug"));
  if (!cat) return c.json({ error: "Not Found" }, 404);
  try {
    const { getDb } = await import("./queries/connection");
    const { categories } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await getDb().select().from(categories).where(eq(categories.slug, cat.slug)).limit(1);
    if (row?.studyGuidePath) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const file = path.resolve(process.cwd(), row.studyGuidePath);
      if (fs.existsSync(file)) {
        return new Response(new Uint8Array(fs.readFileSync(file)), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="SCIENJECT-6.0-${cat.slug}-study-guide.pdf"`,
          },
        });
      }
    }
  } catch {
    // fall through to the placeholder
  }
  const pdf = buildStudyG
uidePdf({ name: cat.name, discipline: cat.discipline, description: cat.description });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="SCIENJECT-6.0-${cat.slug}-study-guide.pdf"`,
    },
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
