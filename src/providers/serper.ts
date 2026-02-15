/**
 * Serper.dev Competitor/SERP Provider — Phase 2 (feature-flagged)
 *
 * Provides Google SERP analysis including:
 * - Competitor ad copy (headlines, descriptions)
 * - Organic rankings
 * - Local pack results
 *
 * Free tier: 2,500 one-time credits for testing.
 * Paid: $4/mo for 100 searches.
 *
 * MUST be behind GROWTH_SERP_ENABLED=true flag.
 */

import type { Config } from '../config.js';
import type { SerpResult, SerpAd, SerpOrganic, SerpLocalPack, PlacesCompetitor } from '../types.js';
import type { CompetitorProvider } from './interfaces.js';

export class SerperCompetitorProvider implements CompetitorProvider {
  private apiKey: string;
  private enabled: boolean;

  constructor(config: Config) {
    this.apiKey = config.serperApiKey;
    this.enabled = config.serpEnabled;
  }

  /**
   * Serper doesn't provide Places-style competitor data.
   * This is a pass-through — use GooglePlacesCompetitorProvider for this.
   */
  async getCompetitors(): Promise<PlacesCompetitor[]> {
    return [];
  }

  /**
   * Get SERP results for a Google search query.
   * Returns null if SERP analysis is disabled.
   */
  async getSerpResults(query: string, location: string): Promise<SerpResult | null> {
    if (!this.enabled || !this.apiKey) {
      return null;
    }

    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: query,
          location,
          gl: 'us',
          hl: 'en',
          num: 10,
        }),
      });

      if (!res.ok) {
        console.error('[Serper] HTTP error:', res.status, await res.text());
        return null;
      }

      const data = await res.json() as any;

      const ads: SerpAd[] = (data.ads || []).map((ad: any, i: number) => ({
        title: ad.title || '',
        description: ad.description || '',
        displayUrl: ad.displayLink || ad.link || '',
        position: i + 1,
      }));

      const organic: SerpOrganic[] = (data.organic || []).map((item: any, i: number) => ({
        title: item.title || '',
        url: item.link || '',
        snippet: item.snippet || '',
        position: i + 1,
      }));

      const localPack: SerpLocalPack[] = (data.places || []).map((place: any) => ({
        name: place.title || '',
        rating: place.rating ?? null,
        reviewCount: place.reviews ?? null,
        address: place.address ?? null,
      }));

      return { query, ads, organic, localPack };
    } catch (err) {
      console.error('[Serper] Error fetching SERP results:', err);
      return null;
    }
  }
}
