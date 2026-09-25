/**
 * decode-assets.mjs — regenerates binary public assets that are stored as
 * base64 text in this repository (the GitHub file API is UTF-8 only, so the
 * SCIENJECT logo ships as base64 sidecar files under scripts/assets/).
 *
 * Runs automatically before `dev` and `build` via the predev/prebuild hooks.
 * It only writes when the decoded bytes differ from what is on disk, so it is
 * safe to run repeatedly on a checkout that already has the real PNG.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Reads a logical base64 sidecar that may be split into ordered parts:
 *   <name>        — single file, or
 *   <name>.partNN — parts concatenated in lexical order.
 */
function readSidecar(dir, name) {
  const single = join(dir, name);
  if (existsSync(single)) return readFileSync(single, "utf8").trim();
  const parts = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.part`))
    .sort();
  if (parts.length === 0) return null;
  return parts.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("");
}

const ASSETS = [
  {
    src: "scienject-logo.png.b64",
    dest: join(root, "public/branding/scienject-logo.png"),
  },
];

const assetsDir = join(root, "scripts/assets");

for (const { src, dest } of ASSETS) {
  const b64 = readSidecar(assetsDir, src);
  if (b64 === null) {
    console.warn(`[decode-assets] missing ${src} (or its parts) — skipped`);
    continue;
  }
  const decoded = Buffer.from(b64, "base64");
  const current = existsSync(dest) ? readFileSync(dest) : null;
  if (current && current.equals(decoded)) continue;
  writeFileSync(dest, decoded);
  console.log(`[decode-assets] wrote ${dest} (${decoded.length} bytes)`);
}
