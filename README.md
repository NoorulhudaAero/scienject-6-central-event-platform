# SCIENJECT 6.0 — Central Event Platform

Live event management, leaderboard, and delegate hub for **SCIENJECT 6.0** at
Lahore Grammar School Gulberg 15C & 16C O/A Level Campus (October 2–4, 2026).
Black & gold luxury theme; 13 competition categories across 3 rounds.

## Stack

React 19 + TypeScript + Vite + Tailwind CSS 3.4 (client) · tRPC 11 + Hono +
Drizzle ORM + MySQL (`mysql2`) (backend, bundled by esbuild) · PDF generation
for passports & the Grand Ledger · QR-code check-in.

## Setup

```bash
npm install
cp .env.example .env       # fill in DATABASE_URL
npm run build              # prebuild regenerates public/branding/scienject-logo.png
npm start                  # serves the Hono API + client from dist/
```

`npm run dev` starts the Vite dev server with the API mounted via
`@hono/vite-dev-server`.

### Binary assets (why the logo is base64)

The GitHub file API is UTF-8 only, so `public/branding/scienject-logo.png` is
**not** stored as a binary blob. It ships as base64 sidecars under
`scripts/assets/scienject-logo.png.b64.part00 … part23`; the `predev`/`prebuild`
hook (`scripts/decode-assets.mjs`) concatenates and decodes them. The two PDF
crests (`api/assets/*Logo*.ts`) are likewise stored as concatenated base64
string constants split across `*DataN.ts` part modules so that no single
source file exceeds the repository transport size. Everything is plain text;
nothing else is required to reconstruct the binaries.

### Database

Schema lives in `db/schema.ts`. After setting `DATABASE_URL`:

```bash
npm run db:generate   # regenerates db/migrations/ (snapshots are gitignored-size, generate locally)
npm run db:migrate    # applies migrations
npm run db:push       # alternatively, push schema directly during development
```

Migration snapshots under `db/migrations/meta/` are intentionally not
committed — regenerate them with `npm run db:generate`.

## Deployment

This is a **full-stack Node application** (Hono + tRPC + MySQL). A static host
alone (e.g. Cloudflare Pages without compute) **cannot run the backend**.

- Any Node host / Docker container: `npm run build && npm start` with
  `DATABASE_URL` pointing at a MySQL database reachable from the host.
- Cloudflare: use **Cloudflare Containers** (or another Node-runtime compute
  product) with an **external MySQL** instance — set `DATABASE_URL` as a
  secret. Do not try to run it as a Pages-only static site.

Required environment variables — see `.env.example`. **Rotate the master admin
key and all director PINs before any real-world exposure** (see Security).

## Security

- The repository is **private**. It contains a placeholder master key and seed
  PIN hashes used during development — **rotate them** (`api/auth.ts`,
  `db/seed.ts`) before going live.
- Admin/director PINs are SHA-256 hashed server-side only; they are never
  shipped to the client.
- Never commit `.env`.

## Notes

- `package-lock.json` is intentionally not committed; run `npm install` to
  regenerate it for reproducible installs.
- Source files are split into small ES modules (e.g. `api/adminRouterA/B/C.ts`,
  `src/pages/dirDash/*`, `src/pages/dept/*`, `src/pages/admin/Section*.tsx`)
  so every file transports cleanly through the GitHub file API.
"# Build Update" 
