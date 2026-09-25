import { createRouter } from "./middleware";
import { adminProcsA } from "./adminRouterA";
import { adminProcsB } from "./adminRouterB";
import { adminProcsC } from "./adminRouterC";

/** Master Admin tRPC surface — procedures spread-merged from A/B/C parts so no
 *  single source file exceeds the repository transport size. Paths unchanged. */
export const adminRouter = createRouter({
  ...adminProcsA,
  ...adminProcsB,
  ...adminProcsC,
});
