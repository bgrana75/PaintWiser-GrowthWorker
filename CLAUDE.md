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

**`fly.toml` is unused scaffolding — this service has never been deployed to Fly.io.** It has exactly one commit (the initial one) and `paintwiser-growth-worker.fly.dev` does not resolve. Do not run `fly deploy` and do not treat `fly.toml` as describing reality; `flyctl` isn't even installed on the dev machine.

**Where it actually runs (verified 2026-08-12):** `http://147.135.15.155:3002` — the user's shared **dev/testing** OVH box, which hosts many unrelated projects (e.g. `aisomer`, behind nginx basic auth on 80/443). Plain HTTP, no TLS, no reverse proxy. `GET /health` returns 200.

**This service has never had a production deployment.** It lives on a dev box and the production hostname was never wired up, so treat "where does this run in prod" as an open question, not a settled fact.

**Known live defect:** the deployed app calls `https://growth.paintwiser.app`, which has no DNS record and never worked — confirmed by inspecting the live web bundle, which has that URL baked in 9 times. A Cloudflare-proxied record could not reach this service anyway, because CF's proxy does not support origin port 3002. **Growth features are broken in production.** The correct address is in `paint-wiser/lib/growth/api-client.ts` as the hardcoded fallback, but the fallback only applies when `EXPO_PUBLIC_GROWTH_WORKER_URL` is unset, and it is set.

Fixing this properly is part of `paint-wiser/docs/self-hosting-migration-plan.md`: move the service behind Caddy on a supported port with real TLS.

The Dockerfile (`node:20-slim`, `npm install` → `npm run build` → `npm prune --production`, listens on 3002) is portable and runs anywhere — keep it that way.

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
