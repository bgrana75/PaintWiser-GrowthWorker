/**
 * Keyword Estimates Provider — Phase 1 Market Data
 *
 * Provides CPC and search volume estimates using industry averages
 * for the painting contractor niche.
 *
 * Phase 1: Template-based estimates (no Google Ads API needed).
 * Phase 2: Replace with real Google Ads Keyword Planner API calls.
 *
 * These estimates are informed by real painting industry data:
 * - Exterior painting: $15-30 CPC, high volume
 * - Interior painting: $10-20 CPC, medium-high volume
 * - Cabinet painting: $8-15 CPC, medium volume
 * - Commercial painting: $12-25 CPC, lower volume
 * - Deck staining: $6-12 CPC, seasonal
 */

import type { KeywordData } from '../types.js';
import type { MarketDataProvider } from './interfaces.js';

// Industry average data by service — CPC ranges (low-high) vary by market
interface ServiceEstimate {
  cpcRange: [number, number]; // [low market CPC, high market CPC]
  volumeRange: [number, number]; // [small market volume, large market volume]
  competition: 'low' | 'medium' | 'high';
  keywords: string[];
}

const SERVICE_ESTIMATES: Record<string, ServiceEstimate> = {
  'exterior painting': {
    cpcRange: [12, 32],
    volumeRange: [400, 2400],
    competition: 'high',
    keywords: [
      'exterior painting',
      'exterior house painting',
      'exterior painter near me',
      'outside house painting',
      'home exterior painting',
      'house painting',
    ],
  },
  'interior painting': {
    cpcRange: [8, 22],
    volumeRange: [300, 1800],
    competition: 'medium',
    keywords: [
      'interior painting',
      'interior house painting',
      'interior painter near me',
      'room painting',
      'indoor painting',
      'house painting interior',
    ],
  },
  'cabinet painting': {
    cpcRange: [6, 18],
    volumeRange: [120, 700],
    competition: 'low',
    keywords: [
      'cabinet painting',
      'kitchen cabinet painting',
      'cabinet refinishing',
      'cabinet painter near me',
      'paint kitchen cabinets',
    ],
  },
  'commercial painting': {
    cpcRange: [10, 28],
    volumeRange: [80, 500],
    competition: 'medium',
    keywords: [
      'commercial painting',
      'commercial painter',
      'office painting',
      'business painting',
      'commercial painting contractor',
    ],
  },
  'deck staining': {
    cpcRange: [5, 15],
    volumeRange: [100, 600],
    competition: 'low',
    keywords: [
      'deck staining',
      'deck refinishing',
      'deck stain near me',
      'wood deck staining',
      'deck restoration',
    ],
  },
};

/**
 * Market competitiveness factor (0.0 to 1.0).
 * Derived from competitor data when available.
 * 0.0 = low competition market, 1.0 = extremely competitive.
 *
 * Heuristic: based on # of competitors found and their avg review counts.
 * - 0-5 competitors with <100 avg reviews → ~0.2 (small market)
 * - 10-15 competitors with 100-300 avg reviews → ~0.5 (medium)
 * - 20 competitors with 300+ avg reviews → ~0.8-1.0 (saturated)
 */

// Google Places caps at 20 results, so 20 = maximum density signal
const MAX_COMPETITORS_SIGNAL = 20;
// Markets with 400+ avg reviews per business are very established
const MAX_AVG_REVIEWS_SIGNAL = 400;
// Review quality is a stronger signal than count (more reviews = harder to compete)
const COMPETITOR_COUNT_WEIGHT = 0.35;
const REVIEW_DENSITY_WEIGHT = 0.65;

export function calculateMarketFactor(competitorCount: number, avgReviewCount: number): number {
  const countFactor = Math.min(competitorCount / MAX_COMPETITORS_SIGNAL, 1.0);
  const reviewFactor = Math.min(avgReviewCount / MAX_AVG_REVIEWS_SIGNAL, 1.0);
  return Math.round((countFactor * COMPETITOR_COUNT_WEIGHT + reviewFactor * REVIEW_DENSITY_WEIGHT) * 100) / 100;
}

function interpolate(range: [number, number], factor: number): number {
  return Math.round((range[0] + (range[1] - range[0]) * factor) * 100) / 100;
}

export class EstimateMarketDataProvider implements MarketDataProvider {
  private marketFactor = 0.5; // default medium market

  /**
   * Set market competitiveness factor based on competitor data.
   * Call this BEFORE getKeywordData() if you have competitor info.
   */
  setMarketFactor(factor: number): void {
    this.marketFactor = Math.max(0, Math.min(1, factor));
    console.log(`[KeywordEstimates] Market factor set to ${this.marketFactor}`);
  }

  async getKeywordData(
    services: string[],
    cities: string[],
    _state: string,
  ): Promise<KeywordData[]> {
    const results: KeywordData[] = [];
    const factor = this.marketFactor;

    for (const service of services) {
      const normalizedService = service.toLowerCase();
      const estimates = this.findServiceEstimates(normalizedService);

      if (!estimates) {
        // Unknown service — generate generic estimates
        results.push(...this.generateGenericEstimates(service, cities));
        continue;
      }

      const baseCpc = interpolate(estimates.cpcRange, factor);
      const baseVolume = Math.round(interpolate(estimates.volumeRange, factor));

      for (const keyword of estimates.keywords) {
        // Base keyword (no city)
        results.push({
          keyword,
          monthlySearches: baseVolume,
          avgCpc: baseCpc,
          competition: estimates.competition,
          service,
        });

        // City-modified keywords:
        // Geo-modified keywords typically get 20-35% of base volume
        // and cost 10-20% more due to higher intent (source: WordStream industry data)
        for (const city of cities) {
          const CITY_VOLUME_BASE = 0.20;
          const CITY_VOLUME_FACTOR = 0.15; // more competitive markets have more city searches
          const CITY_CPC_UPLIFT = 1.15; // geo keywords ~15% more expensive (higher intent)
          const cityFraction = CITY_VOLUME_BASE + factor * CITY_VOLUME_FACTOR;
          results.push({
            keyword: `${keyword} ${city}`,
            monthlySearches: Math.round(baseVolume * cityFraction),
            avgCpc: Math.round(baseCpc * CITY_CPC_UPLIFT * 100) / 100,
            competition: estimates.competition,
            service,
            city,
          });
        }
      }
    }

    return results;
  }

  private findServiceEstimates(normalizedService: string): ServiceEstimate | null {
    // Direct match
    if (SERVICE_ESTIMATES[normalizedService]) {
      return SERVICE_ESTIMATES[normalizedService];
    }

    // Partial match
    const match = Object.entries(SERVICE_ESTIMATES).find(
      ([key]) => normalizedService.includes(key) || key.includes(normalizedService)
    );

    return match ? match[1] : null;
  }

  private generateGenericEstimates(service: string, cities: string[]): KeywordData[] {
    const results: KeywordData[] = [];
    const factor = this.marketFactor;

    // Generic estimates: use market factor to interpolate within a reasonable range.
    // Base range: $8-$20 CPC, 80-400 monthly searches
    const GENERIC_CPC_RANGE: [number, number] = [8, 20];
    const GENERIC_VOLUME_RANGE: [number, number] = [80, 400];
    const CITY_CPC_UPLIFT = 1.15;
    const CITY_VOLUME_FRACTION = 0.25;

    const baseCpc = interpolate(GENERIC_CPC_RANGE, factor);
    const baseVolume = Math.round(interpolate(GENERIC_VOLUME_RANGE, factor));

    const baseKeywords = [
      service.toLowerCase(),
      `${service.toLowerCase()} near me`,
      `${service.toLowerCase()} contractor`,
      `${service.toLowerCase()} services`,
    ];

    for (const keyword of baseKeywords) {
      results.push({
        keyword,
        monthlySearches: baseVolume,
        avgCpc: baseCpc,
        competition: 'medium',
        service,
      });

      for (const city of cities) {
        results.push({
          keyword: `${keyword} ${city}`,
          monthlySearches: Math.round(baseVolume * CITY_VOLUME_FRACTION),
          avgCpc: Math.round(baseCpc * CITY_CPC_UPLIFT * 100) / 100,
          competition: 'medium',
          service,
          city,
        });
      }
    }

    return results;
  }
}
