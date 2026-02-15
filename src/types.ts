/**
 * Shared types for the Growth worker.
 *
 * These define the inputs/outputs of the API endpoints and
 * the data structures passed between providers and the LLM.
 */

// ---------------------------------------------------------------------------
// Market Analysis — Input / Output
// ---------------------------------------------------------------------------

/** What the app sends to POST /api/analyze */
export interface MarketAnalysisRequest {
  services: string[];
  zipCode: string;
  targetCities?: string[];
  radiusMiles?: number;
  websiteUrl?: string;
}

/** Full market analysis result returned to the app */
export interface MarketAnalysis {
  /** Market overview */
  overview: MarketOverview;

  /** Per-service opportunity breakdown */
  serviceOpportunities: ServiceOpportunity[];

  /** Competitor intelligence */
  competitors: CompetitorSnapshot[];

  /** Recommended target cities */
  recommendedCities: RecommendedCity[];

  /** Budget recommendation */
  budgetRecommendation: BudgetRecommendation;

  /** Raw data sources used (for transparency/debugging) */
  dataSourcesUsed: string[];

  /** When this analysis was generated */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Market Overview
// ---------------------------------------------------------------------------

export interface MarketOverview {
  summary: string;
  competitionLevel: 'low' | 'medium' | 'high';
  marketInsight: string;
  websiteAnalysis?: string;
}

// ---------------------------------------------------------------------------
// Service Opportunities
// ---------------------------------------------------------------------------

export interface ServiceOpportunity {
  service: string;
  monthlySearches: number;
  avgCpc: number;
  competition: 'low' | 'medium' | 'high';
  /** From CRM data — null if no CRM data available */
  crmWinRate: number | null;
  crmAvgDealSize: number | null;
  crmQuoteCount: number | null;
  /** AI recommendation */
  recommendation: string;
  /** AI priority ranking (1 = best opportunity) */
  rank: number;
}

// ---------------------------------------------------------------------------
// Competitor Snapshot
// ---------------------------------------------------------------------------

export interface CompetitorSnapshot {
  name: string;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  /** From SERP analysis (Phase 2) — null if SERP disabled */
  adHeadlines: string[] | null;
  adDescriptions: string[] | null;
  /** AI insight about this competitor */
  insight: string | null;
}

// ---------------------------------------------------------------------------
// Recommended Cities
// ---------------------------------------------------------------------------

export interface RecommendedCity {
  city: string;
  state: string;
  /** Estimated monthly searches for painting services */
  estimatedSearches: number | null;
  /** Avg CPC in this city */
  avgCpc: number | null;
  /** Competition level in this city */
  competition: 'low' | 'medium' | 'high' | null;
  /** Distance from provided zip code (miles) */
  distanceMiles: number | null;
  /** AI reasoning for recommending this city */
  reason: string;
  /** Pre-selected by AI based on analysis */
  recommended: boolean;
}

// ---------------------------------------------------------------------------
// Budget Recommendation
// ---------------------------------------------------------------------------

export interface BudgetRecommendation {
  recommendedDailyBudget: number;
  recommendedHardCap: number;
  estimatedClicksPerDay: number;
  estimatedCallsPerWeek: number;
  estimatedCostPerCall: number;
  /** ROI projection if CRM data available */
  projectedRevenuePerMonth: number | null;
  projectedRoi: number | null;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Plan Generation — Input / Output
// ---------------------------------------------------------------------------

/** What the app sends to POST /api/plan */
export interface PlanGenerationRequest {
  /** Market analysis ID to load */
  analysisId: string;
  /** User selections (may differ from AI recommendations) */
  selectedServices: string[];
  selectedCities: string[];
  dailyBudget: number;
  hardCap: number;
  phoneNumber: string;
  businessHours?: BusinessHours;
}

/** Generated campaign plan */
export interface CampaignPlan {
  analysisId: string;
  campaigns: PlannedCampaign[];
  totalDailyBudget: number;
  hardCap: number;
  summary: string;
  generatedAt: string;
}

export interface PlannedCampaign {
  /** Display name: "[PW] {Service}" */
  name: string;
  service: string;
  targetCity: string;
  dailyBudget: number;
  keywords: PlannedKeyword[];
  negativeKeywords?: string[];
  adCopy: AdCopy;
  estimatedClicksPerDay: number;
  estimatedCostPerClick: number;
}

export interface PlannedKeyword {
  keyword: string;
  matchType: 'BROAD' | 'PHRASE' | 'EXACT';
  estimatedCpc?: number | null;
  estimatedMonthlySearches?: number | null;
}

export interface AdCopy {
  headlines: string[];
  descriptions: string[];
}

export interface BusinessHours {
  monday: DaySchedule;
  tuesday: DaySchedule;
  wednesday: DaySchedule;
  thursday: DaySchedule;
  friday: DaySchedule;
  saturday: DaySchedule;
  sunday: DaySchedule;
}

export interface DaySchedule {
  enabled: boolean;
  start: string;
  end: string;
}

// ---------------------------------------------------------------------------
// Provider Data Structures (internal)
// ---------------------------------------------------------------------------

/** Raw keyword data from Keyword Planner or estimates */
export interface KeywordData {
  keyword: string;
  monthlySearches: number;
  avgCpc: number;
  competition: 'low' | 'medium' | 'high';
  service: string;
  city?: string;
}

/** Raw competitor data from Google Places */
export interface PlacesCompetitor {
  placeId: string;
  name: string;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  lat: number;
  lng: number;
  types: string[];
}

/** Raw SERP data from Serper.dev (Phase 2) */
export interface SerpResult {
  query: string;
  ads: SerpAd[];
  organic: SerpOrganic[];
  localPack: SerpLocalPack[];
}

export interface SerpAd {
  title: string;
  description: string;
  displayUrl: string;
  position: number;
}

export interface SerpOrganic {
  title: string;
  url: string;
  snippet: string;
  position: number;
}

export interface SerpLocalPack {
  name: string;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
}

// ---------------------------------------------------------------------------
// CRM Data (read from Supabase)
// ---------------------------------------------------------------------------

export interface CrmSnapshot {
  totalQuotes: number;
  wonQuotes: number;
  totalRevenue: number;
  avgDealSize: number;
  serviceBreakdown: CrmServiceBreakdown[];
  topCities: CrmCityCount[];
}

export interface CrmServiceBreakdown {
  service: string;
  quoteCount: number;
  winRate: number;
  avgDealSize: number;
  totalRevenue: number;
}

export interface CrmCityCount {
  city: string;
  quoteCount: number;
}

// ---------------------------------------------------------------------------
// Usage / Quota
// ---------------------------------------------------------------------------

export interface UsageQuota {
  used: number;
  limit: number;
  remaining: number;
  periodStart: string;
  periodEnd: string;
}

export type AnalysisEventType = 'market_analysis' | 'plan_generation' | 'ad_hoc_analysis' | 'weekly_review';
