/**
 * Google Places Competitor Provider
 *
 * Uses Google Places API (Nearby Search) to find painting contractors
 * near a zip code. Free tier: 28,500 calls/month.
 *
 * Returns: business name, rating, review count, address, coordinates.
 */

import type { Config } from '../config.js';
import type { PlacesCompetitor, SerpResult } from '../types.js';
import type { CompetitorProvider } from './interfaces.js';

export class GooglePlacesCompetitorProvider implements CompetitorProvider {
  private apiKey: string;

  constructor(config: Config) {
    this.apiKey = config.googlePlacesApiKey;
  }

  async getCompetitors(zipCode: string, radiusMiles = 25): Promise<PlacesCompetitor[]> {
    if (!this.apiKey) {
      console.warn('[GooglePlaces] No API key configured — returning empty competitors');
      return [];
    }

    try {
      // Step 1: Geocode the zip code to lat/lng
      const coords = await this.geocodeZip(zipCode);
      if (!coords) {
        console.error('[GooglePlaces] Failed to geocode zip:', zipCode);
        return [];
      }

      // Step 2: Search for painting contractors nearby
      const radiusMeters = Math.round(radiusMiles * 1609.34);
      const results = await this.nearbySearch(coords.lat, coords.lng, radiusMeters);

      return results;
    } catch (err) {
      console.error('[GooglePlaces] Error fetching competitors:', err);
      return [];
    }
  }

  private async geocodeZip(zipCode: string): Promise<{ lat: number; lng: number } | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', zipCode);
    url.searchParams.set('key', this.apiKey);

    const res = await fetch(url.toString());
    const data = await res.json() as any;

    if (data.status !== 'OK' || !data.results?.length) {
      return null;
    }

    const loc = data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng };
  }

  private async nearbySearch(
    lat: number,
    lng: number,
    radiusMeters: number,
  ): Promise<PlacesCompetitor[]> {
    const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
    url.searchParams.set('location', `${lat},${lng}`);
    url.searchParams.set('radius', String(Math.min(radiusMeters, 50000))); // Max 50km
    url.searchParams.set('keyword', 'painting contractor');
    url.searchParams.set('type', 'establishment');
    url.searchParams.set('key', this.apiKey);

    const res = await fetch(url.toString());
    const data = await res.json() as any;

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('[GooglePlaces] Nearby search error:', data.status, data.error_message);
      return [];
    }

    const results: PlacesCompetitor[] = (data.results || []).map((place: any) => ({
      placeId: place.place_id,
      name: place.name,
      rating: place.rating ?? null,
      reviewCount: place.user_ratings_total ?? null,
      address: place.vicinity ?? null,
      lat: place.geometry?.location?.lat ?? 0,
      lng: place.geometry?.location?.lng ?? 0,
      types: place.types || [],
    }));

    // Sort by review count descending (most established first)
    results.sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));

    // Cap at 20 most relevant competitors
    return results.slice(0, 20);
  }

  /**
   * SERP results — not supported by Google Places.
   * This method exists to satisfy the CompetitorProvider interface.
   * Use SerperCompetitorProvider for SERP data.
   */
  async getSerpResults(): Promise<SerpResult | null> {
    return null;
  }
}
