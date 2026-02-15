/**
 * Provider Interfaces — Abstractions for external data sources.
 *
 * Each provider has a clear interface so backends can be swapped:
 * - MarketDataProvider: keyword volumes, CPC estimates
 * - CompetitorProvider: competitor businesses + ad intelligence
 * - LlmProvider: AI synthesis and content generation
 *
 * Phase 1: Google Places + keyword estimates + OpenAI
 * Phase 2: + Serper.dev for SERP/ad copy analysis
 */

import type {
  KeywordData,
  PlacesCompetitor,
  SerpResult,
  CrmSnapshot,
  ServiceOpportunity,
  CompetitorSnapshot,
  RecommendedCity,
  BudgetRecommendation,
  AdCopy,
} from '../types.js';

// ---------------------------------------------------------------------------
// Market Data Provider (keyword volumes, CPC)
// ---------------------------------------------------------------------------

export interface MarketDataProvider {
  /**
   * Get keyword data for services in target cities.
   * Phase 1: template-based CPC estimates from industry averages.
   * Phase 2: real Google Ads Keyword Planner API.
   */
  getKeywordData(
    services: string[],
    cities: string[],
    state: string,
  ): Promise<KeywordData[]>;
}

// ---------------------------------------------------------------------------
// Competitor Provider (businesses, ratings, ad copy)
// ---------------------------------------------------------------------------

export interface CompetitorProvider {
  /**
   * Find painting contractor competitors near a location.
   */
  getCompetitors(
    zipCode: string,
    radiusMiles?: number,
  ): Promise<PlacesCompetitor[]>;

  /**
   * Get SERP analysis for a query (Phase 2 — Serper.dev).
   * Returns null if SERP is disabled.
   */
  getSerpResults?(
    query: string,
    location: string,
  ): Promise<SerpResult | null>;
}

// ---------------------------------------------------------------------------
// LLM Provider (AI synthesis)
// ---------------------------------------------------------------------------

export interface LlmProvider {
  /**
   * Synthesize all gathered data into a market analysis.
   */
  synthesizeMarketAnalysis(input: LlmMarketAnalysisInput): Promise<LlmMarketAnalysisOutput>;

  /**
   * Generate a campaign plan from analysis + user selections.
   */
  generateCampaignPlan(input: LlmPlanInput): Promise<LlmPlanOutput>;

  /**
   * Generate ad copy for a specific service + city.
   */
  generateAdCopy(service: string, city: string, competitorInsights: string[]): Promise<AdCopy>;
}

/** Input for the LLM to synthesize a market analysis */
export interface LlmMarketAnalysisInput {
  services: string[];
  zipCode: string;
  keywords: KeywordData[];
  competitors: PlacesCompetitor[];
  serpResults: SerpResult[];
  crmData: CrmSnapshot | null;
  websiteUrl?: string;
  /** Pre-formatted website content extracted by the website analyzer */
  websiteContent?: string;
}

/** Structured output from LLM market analysis */
export interface LlmMarketAnalysisOutput {
  summary: string;
  serviceOpportunities: ServiceOpportunity[];
  competitorSnapshots: CompetitorSnapshot[];
  recommendedCities: RecommendedCity[];
  budgetRecommendation: BudgetRecommendation;
  competitionLevel: 'low' | 'medium' | 'high';
  marketInsight: string;
  websiteAnalysis?: string;
}

/** Input for campaign plan generation */
export interface LlmPlanInput {
  marketAnalysis: {
    summary: string;
    serviceOpportunities: ServiceOpportunity[];
    competitors: CompetitorSnapshot[];
    budgetRecommendation: BudgetRecommendation;
  };
  selectedServices: string[];
  selectedCities: string[];
  dailyBudget: number;
  hardCap: number;
  phoneNumber: string;
}

/** Structured output from LLM plan generation */
export interface LlmPlanOutput {
  campaigns: Array<{
    name: string;
    service: string;
    targetCity: string;
    dailyBudget: number;
    keywords: Array<{
      keyword: string;
      matchType: 'BROAD' | 'PHRASE' | 'EXACT';
    }>;
    negativeKeywords?: string[];
    adCopy: AdCopy;
    estimatedClicksPerDay: number;
    estimatedCostPerClick: number;
  }>;
  summary: string;
}
