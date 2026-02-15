/**
 * Google Ads Keyword Planner Provider — Real Market Data
 *
 * Replaces the template-based EstimateMarketDataProvider with real
 * Google Ads Keyword Planner API calls. Returns actual CPC estimates,
 * search volumes, and competition levels for painting-related keywords
 * in the user's target geographic area.
 *
 * Requires:
 *   - Google Ads MCC account
 *   - OAuth credentials (client_id, client_secret, refresh_token)
 *   - Developer token (test or basic)
 *
 * Falls back to EstimateMarketDataProvider if credentials are missing
 * or API calls fail.
 */

import { GoogleAdsApi, services as googleAdsServices, enums } from 'google-ads-api';
import type { KeywordData } from '../types.js';
import type { MarketDataProvider } from './interfaces.js';
import type { Config } from '../config.js';

// US country geo target constant (used as fallback)
const US_GEO_TARGET = 'geoTargetConstants/2840';
// English language constant
const ENGLISH_LANGUAGE = 'languageConstants/1000';

// Map Google's competition enum to our string type
function mapCompetition(level: number | undefined | null): 'low' | 'medium' | 'high' {
  switch (level) {
    case enums.KeywordPlanCompetitionLevel.LOW:
      return 'low';
    case enums.KeywordPlanCompetitionLevel.MEDIUM:
      return 'medium';
    case enums.KeywordPlanCompetitionLevel.HIGH:
      return 'high';
    default:
      return 'medium';
  }
}

// Convert micros to dollars (Google Ads uses micros: 1,000,000 = $1.00)
function microsToDollars(micros: number | Long | null | undefined): number {
  if (!micros) return 0;
  const num = typeof micros === 'number' ? micros : Number(micros);
  return Math.round((num / 1_000_000) * 100) / 100;
}

// Painting service seed keywords — used to generate keyword ideas
const PAINTING_SEED_KEYWORDS: Record<string, string[]> = {
  'exterior painting': ['exterior painting', 'house painting exterior', 'exterior painter'],
  'interior painting': ['interior painting', 'house painting interior', 'interior painter'],
  'cabinet painting': ['cabinet painting', 'kitchen cabinet painting', 'cabinet refinishing'],
  'commercial painting': ['commercial painting', 'commercial painter', 'office painting'],
  'deck staining': ['deck staining', 'deck refinishing', 'deck restoration'],
  'pressure washing': ['pressure washing', 'power washing', 'pressure washing service'],
  'drywall repair': ['drywall repair', 'drywall contractor', 'drywall patching'],
  'wallpaper': ['wallpaper installation', 'wallpaper removal', 'wallpaper hanger'],
  'epoxy flooring': ['epoxy flooring', 'garage floor epoxy', 'epoxy coating'],
  'stucco': ['stucco repair', 'stucco painting', 'stucco contractor'],
};

// Get seed keywords for a service, with generic fallback
function getSeedKeywords(service: string): string[] {
  const normalized = service.toLowerCase();
  // Direct match
  if (PAINTING_SEED_KEYWORDS[normalized]) {
    return PAINTING_SEED_KEYWORDS[normalized];
  }
  // Partial match
  const match = Object.entries(PAINTING_SEED_KEYWORDS).find(
    ([key]) => normalized.includes(key) || key.includes(normalized)
  );
  if (match) return match[1];
  // Generic fallback
  return [normalized, `${normalized} near me`, `${normalized} contractor`];
}

export class GoogleAdsKeywordPlannerProvider implements MarketDataProvider {
  private client: GoogleAdsApi;
  private config: Config;
  private geoTargetCache = new Map<string, string>(); // zip/city → geoTargetConstant resource name

  constructor(config: Config) {
    this.config = config;
    this.client = new GoogleAdsApi({
      client_id: config.googleAdsClientId,
      client_secret: config.googleAdsClientSecret,
      developer_token: config.googleAdsDeveloperToken,
    });
  }

  /**
   * Check if the provider has valid credentials to make API calls.
   */
  static isConfigured(config: Config): boolean {
    return !!(
      config.googleAdsDeveloperToken &&
      config.googleAdsClientId &&
      config.googleAdsClientSecret &&
      config.googleAdsRefreshToken &&
      config.googleAdsMccCustomerId
    );
  }

  async getKeywordData(
    services: string[],
    cities: string[],
    _state: string,
  ): Promise<KeywordData[]> {
    const results: KeywordData[] = [];
    const mccCustomerId = this.config.googleAdsMccCustomerId;

    const customer = this.client.Customer({
      customer_id: mccCustomerId,
      refresh_token: this.config.googleAdsRefreshToken,
      login_customer_id: mccCustomerId,
    });

    // Try to resolve geo targets for the target cities
    const geoTargets = await this.resolveGeoTargets(customer, cities);
    const geoTargetConstants = geoTargets.length > 0 ? geoTargets : [US_GEO_TARGET];

    console.log(`[KeywordPlanner] Using geo targets: ${geoTargetConstants.join(', ')}`);

    // Generate keyword ideas for each service
    for (const service of services) {
      try {
        const seedKeywords = getSeedKeywords(service);
        console.log(`[KeywordPlanner] Fetching ideas for "${service}" with seeds: ${seedKeywords.join(', ')}`);

        const response = await customer.keywordPlanIdeas.generateKeywordIdeas(
          new googleAdsServices.GenerateKeywordIdeasRequest({
            customer_id: mccCustomerId,
            keyword_seed: new googleAdsServices.KeywordSeed({ keywords: seedKeywords }),
            geo_target_constants: geoTargetConstants,
            language: ENGLISH_LANGUAGE,
            keyword_plan_network: enums.KeywordPlanNetwork.GOOGLE_SEARCH,
            page_size: 50,
          })
        );

        if (!response || !response.results || response.results.length === 0) {
          console.warn(`[KeywordPlanner] No results for "${service}"`);
          continue;
        }

        console.log(`[KeywordPlanner] Got ${response.results.length} ideas for "${service}"`);

        for (const idea of response.results) {
          const metrics = idea.keyword_idea_metrics;
          if (!metrics) continue;

          const keyword = idea.text || '';
          const avgCpc = microsToDollars(metrics.average_cpc_micros);
          const monthlySearches = Number(metrics.avg_monthly_searches || 0);
          const competition = mapCompetition(metrics.competition as number);

          // Skip keywords with no data
          if (monthlySearches === 0 && avgCpc === 0) continue;

          // Determine if this keyword is city-specific
          const matchedCity = cities.find(city =>
            keyword.toLowerCase().includes(city.toLowerCase())
          );

          results.push({
            keyword,
            monthlySearches,
            avgCpc,
            competition,
            service,
            ...(matchedCity && { city: matchedCity }),
          });
        }
      } catch (err: any) {
        const errorMsg = err.message || JSON.stringify(err);
        if (errorMsg.includes('No customer found')) {
          console.error(`[KeywordPlanner] Error for "${service}": No customer found. This is expected with a test developer token — Basic Access is required for production use.`);
        } else {
          console.error(`[KeywordPlanner] Error for "${service}":`, errorMsg);
        }
        // Don't throw — continue with other services
      }
    }

    // If we got no results at all, that's a problem but don't crash
    if (results.length === 0) {
      console.warn('[KeywordPlanner] No keyword data returned from API. Check credentials and account status.');
    }

    return results;
  }

  /**
   * Resolve city names to Google Ads geo target constant resource names.
   * Uses GeoTargetConstantService.suggestGeoTargetConstants.
   */
  private async resolveGeoTargets(customer: any, cities: string[]): Promise<string[]> {
    if (cities.length === 0) return [];

    const resolved: string[] = [];

    for (const city of cities) {
      // Check cache
      if (this.geoTargetCache.has(city)) {
        resolved.push(this.geoTargetCache.get(city)!);
        continue;
      }

      try {
        // Use suggestGeoTargetConstants API to find geo target for this city
        const suggestions = await customer.geoTargetConstants.suggestGeoTargetConstants(
          new googleAdsServices.SuggestGeoTargetConstantsRequest({
            locale: 'en',
            country_code: 'US',
            location_names: new googleAdsServices.SuggestGeoTargetConstantsRequest.LocationNames({
              names: [city],
            }),
          })
        );

        if (suggestions && suggestions.geo_target_constant_suggestions?.length > 0) {
          const suggestion = suggestions.geo_target_constant_suggestions[0];
          const resourceName = suggestion.geo_target_constant?.resource_name;
          if (resourceName) {
            this.geoTargetCache.set(city, resourceName);
            resolved.push(resourceName);
            console.log(`[KeywordPlanner] Resolved "${city}" → ${resourceName}`);
          }
        }
      } catch (err: any) {
        console.warn(`[KeywordPlanner] Could not resolve geo target for "${city}":`, err.message || err);
      }
    }

    return resolved;
  }
}
