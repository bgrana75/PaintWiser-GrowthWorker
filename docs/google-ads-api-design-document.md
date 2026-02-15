# PaintWiser — Google Ads API Design Document

## 1. Product Overview

**PaintWiser** is a cross-platform SaaS application (iOS, Android, Web) built for painting contractors. The Growth module within PaintWiser helps contractors generate leads by creating and managing Google Ads Search campaigns. 

**Website:** https://www.paintwiser.com  
**MCC Account ID:** 252-469-6376  
**Company Type:** Independent Google Ads Developer  

---

## 2. Google Ads API Usage

PaintWiser uses the Google Ads API for three primary purposes:

### 2.1 Keyword Research (Keyword Planner Service)
- **API Service:** `KeywordPlanIdeaService`
- **Purpose:** Generate keyword suggestions and CPC/volume estimates for painting-related services in a user's target geographic area.
- **Flow:** User enters their business location (zip code) and services offered → PaintWiser calls the Keyword Planner API to fetch real keyword ideas, average monthly searches, and CPC estimates → Results are displayed to the user for review and selection.
- **Frequency:** On-demand, triggered by user action (campaign creation wizard). Estimated 1-5 calls per user session.

### 2.2 Campaign Management (Campaign, Ad Group, Ad, Keyword Services)
- **API Services:** `CampaignService`, `AdGroupService`, `AdGroupAdService`, `AdGroupCriterionService`, `GeoTargetConstantService`
- **Purpose:** Create and manage Google Ads Search campaigns on behalf of users who have connected their own Google Ads accounts.
- **Flow:** User reviews AI-generated campaign plan (keywords, ad copy, budget) → User approves and clicks "Launch" → PaintWiser creates the campaign structure in the user's Google Ads account via the API.
- **Campaign Structure:**
  - 1 Search Campaign per service area
  - Ad Groups organized by service type (e.g., "Interior Painting", "Exterior Painting")
  - Responsive Search Ads with multiple headlines (30 char) and descriptions (90 char)
  - Keywords with appropriate match types
  - Negative keywords for irrelevant traffic
  - Geographic targeting by zip code / radius
- **Frequency:** Campaign creation is infrequent (1-3 campaigns per user). Status checks and minor updates may occur periodically.

### 2.3 Reporting (Google Ads Query Language)
- **API Service:** `GoogleAdsService.SearchStream`
- **Purpose:** Retrieve campaign performance metrics (impressions, clicks, cost, conversions) to display in the PaintWiser dashboard.
- **Metrics:** Impressions, clicks, CTR, average CPC, cost, conversions, conversion rate.
- **Frequency:** Periodic polling (every few hours) or on-demand when user views their dashboard.

---

## 3. Authentication & Authorization

### 3.1 OAuth 2.0 Flow
- PaintWiser uses OAuth 2.0 to obtain user consent before accessing their Google Ads account.
- **Flow:**
  1. User clicks "Connect Google Ads" in PaintWiser.
  2. User is redirected to Google's OAuth consent screen.
  3. User grants PaintWiser access to their Google Ads account.
  4. PaintWiser receives an authorization code, exchanges it for access + refresh tokens.
  5. Refresh tokens are securely stored (encrypted) in PaintWiser's database.
  6. All subsequent API calls use the refresh token to obtain short-lived access tokens.

### 3.2 MCC (Manager Account) Architecture
- PaintWiser operates under a single MCC account (252-469-6376).
- Each PaintWiser user links their own Google Ads customer account to the MCC via OAuth.
- PaintWiser never creates Google Ads accounts — users must have their own.
- The MCC relationship allows PaintWiser to make API calls on behalf of linked accounts using the `login-customer-id` header.

### 3.3 Token Security
- Refresh tokens are stored encrypted in Supabase (PostgreSQL) with RLS policies.
- Access tokens are never persisted — only held in memory during API calls.
- Users can revoke access at any time from PaintWiser settings or their Google Account.

---

## 4. Architecture

```
┌─────────────────────┐
│   PaintWiser App    │  (React Native — iOS/Android/Web)
│   (Frontend)        │
└────────┬────────────┘
         │ HTTPS (JWT Auth)
         ▼
┌─────────────────────┐
│  Growth Worker API  │  (Node.js/Express — Dedicated Server)
│  - Campaign Wizard  │
│  - Keyword Research  │
│  - Campaign Launch   │
│  - Performance Sync  │
└────────┬────────────┘
         │
    ┌────┴─────┐
    ▼          ▼
┌────────┐ ┌──────────────┐
│Supabase│ │ Google Ads   │
│  (DB)  │ │    API       │
└────────┘ └──────────────┘
```

- **Frontend:** Cross-platform app built with Expo/React Native.
- **Growth Worker:** Standalone Node.js/Express API server that handles all Google Ads API interactions. Deployed on a dedicated server via Docker.
- **Supabase:** PostgreSQL database for user data, campaign records, and encrypted OAuth tokens.
- **Google Ads API:** Accessed exclusively from the Growth Worker (server-side). Never called from the client.

---

## 5. Rate Limiting & Error Handling

- PaintWiser implements exponential backoff with jitter for retryable errors (RESOURCE_EXHAUSTED, INTERNAL_ERROR).
- API calls are queued and rate-limited to stay well within Google Ads API quotas.
- Failed operations are logged and surfaced to users with actionable error messages.
- The test token's 15,000 operations/day limit is monitored; basic token limits (15,000/day) will be respected in production.

---

## 6. Compliance

- **Terms of Service:** PaintWiser complies with the Google Ads API Terms of Service.
- **Privacy Policy:** Available at https://www.paintwiser.com/privacy
- **Terms of Use:** Available at https://www.paintwiser.com/terms
- **Data Handling:** User Google Ads data is only used to display performance metrics within PaintWiser and to manage campaigns the user has explicitly created. Data is never shared with third parties.
- **Required Disclosures:** PaintWiser's privacy policy discloses the use of the Google Ads API and what data is accessed.
- **Minimum Functionality:** PaintWiser provides full value to users (estimating, invoicing, scheduling, CRM) independently of Google Ads features. The Google Ads integration is an optional growth module.

---

## 7. User Experience Flow

1. **Onboarding:** User signs up for PaintWiser and sets up their painting business profile.
2. **Growth Tab:** User navigates to the Growth module and starts the Campaign Wizard.
3. **Wizard Steps:**
   - Enter target area (zip code) and services offered
   - AI analyzes the market using Keyword Planner data
   - AI generates a campaign plan with keywords, ad copy, and budget recommendation
   - User reviews and edits the plan (inline editing of headlines, descriptions, keywords)
   - User connects their Google Ads account via OAuth (one-time)
   - User approves and launches the campaign
4. **Dashboard:** User monitors campaign performance (clicks, leads, cost) in PaintWiser.
5. **Optimization:** PaintWiser provides AI-powered optimization suggestions based on performance data.

---

## 8. Contact

- **Developer:** PaintWiser LLC
- **Email:** paintwiserapp@gmail.com
- **Website:** https://www.paintwiser.com

---

## 9. Implementation Status & TODOs

### Completed
- [x] MCC account created (252-469-6376)
- [x] Test developer token obtained (`6ee5jkCjMxIRRRnzEetHaQ`)
- [x] Basic Access token application submitted (email: paintwiserapp@gmail.com)
- [x] OAuth client credentials created (Client ID + Secret)
- [x] Google Ads Keyword Planner provider built and tested (geo targets resolve correctly)
- [x] All template/fallback keyword data removed — real data only
- [x] LLM prompts hardened (forces 0/null when no real keyword data)
- [x] OAuth routes built (`/oauth/google-ads/start` + `/callback`)
- [x] Growth Hub page (multi-feature cards grid)
- [x] GoogleAdsConnect onboarding page (requirements, guide, OAuth button)
- [x] Wizard gated behind active Google Ads connection
- [x] DB schema updated (`connected_by_user_id`, `encrypted_access_token`, `token_expires_at`)

### Waiting On
- [ ] **Basic Access token approval** (2-5 business days from application, submitted ~Feb 2026)
  - Once approved, Keyword Planner API will return real CPC/volume data
  - Currently returns "No customer found" (expected with test token)

### TODO (After Basic Access)
- [ ] **Add OAuth redirect URIs to Google Cloud Console:**
  - Dev: `http://localhost:3002/oauth/google-ads/callback`
  - Production: `https://growth.paintwiser.com/oauth/google-ads/callback` (or `http://147.135.15.155:3002/oauth/google-ads/callback`)
- [ ] Test full OAuth flow end-to-end with a real Google Ads account
- [ ] Test Keyword Planner with real keyword/CPC data
- [ ] Build campaign creation (Phase 2 — Campaign, AdGroup, Ad, Keyword services)
- [ ] Build performance reporting dashboard (Phase 3 — GAQL queries)
- [ ] Implement token encryption for production (currently plaintext in DB)
- [ ] Deploy updated growth worker to production server
