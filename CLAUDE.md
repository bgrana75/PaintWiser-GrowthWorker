# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `../CLAUDE.md` for how this repo relates to the other PaintWiser repos.

## Project

HTTP worker backing the Growth tab of the main PaintWiser app. Two domains:

1. **Google Ads growth** — Keyword Planner data, Google Places + Serper.dev competitor/SERP research, and a Supabase CRM snapshot (quotes/properties, 12-month lookback), synthesized by OpenAI into a market analysis and then a campaign plan.
2. **Google Business Profile (GBP)** — OAuth connect, location selection, review import, AI-drafted review replies, AI-generated GBP posts (including DALL·E images), daily performance metrics and health score.

Despite the name it is **not a cron or queue worker** — it is a request/response Express service. There are no schedulers, jobs, or background workers.

## Commands

Package manager is **npm** (`package-lock.json` only). Node >= 20.

- `npm run dev` — `tsx watch src/index.ts`
- `npm run build` — `tsc` → `dist/`
- `npm start` — `node dist/index.js`
- `npm run typecheck` — `tsc --noEmit`

**`npm run typecheck` is the only automated gate.** There are no tests and no lint config. Run it before committing.

## ESM import gotcha

`tsconfig.json` uses `module: NodeNext`. **Every relative import must carry an explicit `.js` extension, even though it points at a `.ts` file:**

```ts
import { loadConfig } from './config.js';
import type { Config } from '../config.js';
```

Omitting it breaks the build or runtime. There are no path aliases — relative imports only.

## Deployment

**Where it runs (verified 2026-08-17):** `https://growth.paintwiser.app` — the
self-hosted OVH box `51.81.67.77`, as the systemd service
`paintwiser-growth-worker` on `127.0.0.1:4005`, fronted by Caddy with real TLS
and Cloudflare in front of that. `GET /health` returns
`{"status":"ok","service":"growth-worker"}`.

Deploy with `paintwiser-deploy growth-worker` over `ssh ubuntu@51.81.67.77`. That
pulls, runs `npm install && npm run build && npm prune --omit=dev`, restarts the
unit, health-checks `http://127.0.0.1:4005/health`, and rolls back to the previous
commit if the check fails. Env lives in `/opt/paintwiser/env/growth-worker.env`,
not in a repo `.env`.

This service used to run on the user's shared **dev/testing** box at
`http://147.135.15.155:3002` over plain HTTP, and `https://growth.paintwiser.app`
had no DNS record, so Growth features were broken in production. Both halves are
fixed. **The dev box is still answering on :3002** — it has not been
decommissioned, so do not treat a healthy response from that address as evidence
of anything.

`fly.toml` and the `Dockerfile` were deleted on 2026-08-17. This service was never
deployed to Fly, `paintwiser-growth-worker.fly.dev` never resolved, and the
Dockerfile's only consumer was `fly.toml`'s `[build]` — it still `EXPOSE`d 3002
while the service listens on 4005. Deployment is systemd, not a container.

**Security note:** `EXPO_PUBLIC_GROWTH_API_KEY` is an `EXPO_PUBLIC_*` variable, so Expo inlines it into the client bundle at build time. Any user of the app can extract it and call this service directly, which spends OpenAI and Google Ads quota. Treat it as public, not as a secret, and rely on the Supabase-JWT path plus `usageMiddleware` quotas for real authorization.

## Architecture

```
src/index.ts          Express bootstrap, CORS allowlist, route mounting
src/config.ts         loadConfig() → Config from process.env
src/db.ts             Supabase service-role client, CRM snapshot, quota, analysis persistence
src/middleware/       auth.ts (API key + Supabase JWT → req.auth), usage.ts (monthly quota)
src/providers/        MarketDataProvider / CompetitorProvider / LlmProvider implementations
src/routes/           analysis.ts, plan.ts, oauth.ts, oauth-gbp.ts, gbp.ts
src/services/         market-analysis.ts, plan-generation.ts, website-analyzer.ts
```

**Mount order in `src/index.ts` matters.** `/health` and both `/oauth/*` routers are unauthenticated; `/api/gbp` and `/api` sit behind `authMiddleware`; `/api/analyze` and `/api/plan` additionally sit behind `usageMiddleware`.

Routers are **factory functions taking their dependencies** — `createAnalysisRouter(service)`, `createGbpRouter(config)`. Follow that pattern; the DB (`initDb`/`getDb`) is the only module-level singleton.

Auth accepts either the `GROWTH_API_KEY` header or a Supabase JWT, and populates `req.auth` with `{ accountId, userId }`. `DEV_BYPASS_AUTH` is a local escape hatch. Note the quota middleware **fails open** on error — a quota-check failure lets the request through.

The CORS allowlist is hardcoded in `src/index.ts`. New client origins must be added there.

## Conventions

- **Single quotes**, semicolons, 2-space indent.
- Every file opens with a JSDoc banner listing its purpose and endpoints; each route gets a `/** METHOD /path */` block above it. Keep the banner in `src/routes/gbp.ts` in sync when adding endpoints.
- Success responses are `res.json({ success: true, data })`; failures are `res.status(n).json({ error, message })`.
- Every handler is one `try`/`catch`; the catch logs `console.error('[Scope] message:', err)` then responds. Logging is `console.*` only, always with a bracket tag — `[Growth Worker]`, `[Route]`, `[Auth]`, `[Usage]`, `[CRM]`, `[GBP]`.
- Handler return style is inconsistent in the existing code (older routes are `Promise<void>` with `res.status(...).json(...); return;`, newer `gbp.ts` code uses `return res.status(...)`). Match the surrounding file.
- Same for auth access — older code uses `req.auth!`, newer `gbp.ts` code uses `(req as any).auth`.
- `src/providers/keyword-estimates.ts` is legacy and deliberately removed from the barrel: real data only, no template fallbacks. Don't reintroduce it.

## Database

`sql/001_growth_tables.sql` is run **by hand in the Supabase SQL Editor** — there is no migration tool. It creates `growth_usage_log`, `growth_market_analyses`, and `growth_campaign_plans` with permissive service-role RLS policies and `set_updated_at()` triggers. No DELETE policies — soft deletes only.

Several tables this code reads are **not** defined here; their schema lives in `../paint-wiser/supabase-state.sql`: `growth_connected_accounts`, `growth_gbp_profile`, `growth_gbp_reviews`, `growth_gbp_posts`, `growth_gbp_metrics_daily`, plus `quotes` and `properties`. Changing those means editing the main repo.

## Env

`.env.example` covers: `PORT`, `GROWTH_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LLM_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `GOOGLE_PLACES_API_KEY`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `SERPER_API_KEY`, `GROWTH_SERP_ENABLED`.

Used in code but **missing from `.env.example`**: `GBP_CLIENT_ID`, `GBP_CLIENT_SECRET`, `GOOGLE_ADS_MCC_CUSTOMER_ID`, `DEV_BYPASS_AUTH`, `DEV_ACCOUNT_ID`, `DEV_USER_ID`, `NODE_ENV`. Add them if you touch that file.

`docs/google-ads-api-design-document.md` is the Google Ads API access-approval doc — read it before changing Google Ads request patterns or the MCC / `login-customer-id` handling.
