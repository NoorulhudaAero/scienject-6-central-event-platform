import { createRouter, publicQuery } from "./middleware";
import { publicRouter } from "./publicRouter";
import { authRouter } from "./authRouter";
import { directorRouter } from "./directorRouter";
import { adminRouter } from "./adminRouter";
import { departmentRouter } from "./departmentRouter";
import { pingsRouter } from "./pingsRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  public: publicRouter,
  auth: authRouter,
  director: directorRouter,
  admin: adminRouter,
  department: departmentRouter,
  pings: pingsRouter,
});

export type AppRouter = typeof appRouter;
