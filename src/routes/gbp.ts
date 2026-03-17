/**
 * Google Business Profile API Routes
 *
 * Authenticated endpoints for GBP operations:
 *
 *   GET  /api/gbp/locations         — List accessible business locations (after OAuth)
 *   POST /api/gbp/select-location   — User selects a location, creates profile row
 *   GET  /api/gbp/profile           — Get stored profile data
 *
 * All routes require auth middleware (API key + JWT).
 * All GBP API calls use the connection's access token (server-side only).
 */

import { Router, Request, Response } from 'express';
import type { Config } from '../config.js';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Google Business Profile API base URL
// Using the Business Information API (v1) — the current API for managing GBP data
const GBP_API_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GBP_ACCOUNT_API_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';

interface GbpLocation {
  name: string;            // Resource name: "locations/123456"
  title: string;           // Business name
  storefrontAddress?: {
    addressLines: string[];
    locality: string;      // City
    administrativeArea: string; // State
    postalCode: string;
  };
  phoneNumbers?: {
    primaryPhone?: string;
  };
  websiteUri?: string;
}

export function createGbpRouter(config: Config): Router {
  const router = Router();
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  /**
   * GET /api/gbp/locations
   *
   * Lists the business locations accessible to the user's GBP connection.
   * The user picks one of these to manage via PaintWiser.
   */
  router.get('/locations', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;

    try {
      // Get the active GBP connection for this account
      const { data: connection, error: connError } = await supabase
        .from('growth_connected_accounts')
        .select('*')
        .eq('account_id', accountId)
        .eq('provider', 'google_business_profile')
        .eq('status', 'active')
        .eq('deleted', false)
        .maybeSingle();

      if (connError || !connection) {
        res.status(404).json({ error: 'No active GBP connection found. Please connect first.' });
        return;
      }

      const accessToken = connection.encrypted_access_token;
      if (!accessToken) {
        res.status(401).json({ error: 'No access token available. Please reconnect.' });
        return;
      }

      // Step 1: List accounts the user has access to
      const accountsResponse = await fetch(`${GBP_ACCOUNT_API_BASE}/accounts`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!accountsResponse.ok) {
        const errBody = await accountsResponse.text();
        console.error('[GBP] Failed to list accounts:', accountsResponse.status, errBody);

        // If 401, the token may be expired
        if (accountsResponse.status === 401) {
          // Try to refresh the token
          const refreshed = await refreshAccessToken(connection, supabase, config);
          if (!refreshed) {
            res.status(401).json({ error: 'Access token expired. Please reconnect.' });
            return;
          }
          // Retry with refreshed token
          const retryResponse = await fetch(`${GBP_ACCOUNT_API_BASE}/accounts`, {
            headers: { 'Authorization': `Bearer ${refreshed}` },
          });
          if (!retryResponse.ok) {
            const retryErr = await retryResponse.text();
            console.error('[GBP] Retry after refresh failed:', retryResponse.status, retryErr);
            res.status(502).json({ error: 'Failed to list GBP accounts after token refresh.' });
            return;
          }
          const retryData = await retryResponse.json() as { accounts?: Array<{ name: string }> };
          return await fetchAndReturnLocations(retryData, refreshed, res);
        }

        res.status(502).json({ error: 'Failed to list GBP accounts.' });
        return;
      }

      const accountsData = await accountsResponse.json() as { accounts?: Array<{ name: string }> };
      await fetchAndReturnLocations(accountsData, accessToken, res);

    } catch (err) {
      console.error('[GBP] Unexpected error listing locations:', err);
      res.status(500).json({ error: 'Failed to list locations.' });
    }
  });

  /**
   * Fetch locations for all GBP accounts and return them.
   */
  async function fetchAndReturnLocations(
    accountsData: { accounts?: Array<{ name: string }> },
    accessToken: string,
    res: Response
  ) {
    const accounts = accountsData.accounts || [];
    if (accounts.length === 0) {
      res.json({ success: true, data: { locations: [] } });
      return;
    }

    // Step 2: For each account, list locations
    const allLocations: Array<{
      locationId: string;
      businessName: string;
      address: string;
      phone: string | null;
      website: string | null;
      accountName: string;
    }> = [];

    for (const account of accounts) {
      try {
        const locResponse = await fetch(
          `${GBP_API_BASE}/${account.name}/locations?readMask=name,title,storefrontAddress,phoneNumbers,websiteUri`,
          {
            headers: { 'Authorization': `Bearer ${accessToken}` },
          }
        );

        if (!locResponse.ok) {
          console.warn(`[GBP] Failed to list locations for ${account.name}:`, locResponse.status);
          continue;
        }

        const locData = await locResponse.json() as { locations?: GbpLocation[] };
        for (const loc of locData.locations || []) {
          const addr = loc.storefrontAddress;
          const addressStr = addr
            ? [
                ...(addr.addressLines || []),
                addr.locality,
                addr.administrativeArea,
                addr.postalCode,
              ]
                .filter(Boolean)
                .join(', ')
            : '';

          allLocations.push({
            locationId: loc.name, // "locations/123456"
            businessName: loc.title || 'Unnamed Business',
            address: addressStr,
            phone: loc.phoneNumbers?.primaryPhone || null,
            website: loc.websiteUri || null,
            accountName: account.name,
          });
        }
      } catch (err) {
        console.warn(`[GBP] Error fetching locations for ${account.name}:`, err);
      }
    }

    console.log(`[GBP] Found ${allLocations.length} location(s)`);
    res.json({ success: true, data: { locations: allLocations } });
  }

  /**
   * POST /api/gbp/select-location
   *
   * User picks a location from the list. This:
   * 1. Updates the connection row with external_customer_id = locationId
   * 2. Creates a growth_gbp_profile row with the location details
   */
  router.post('/select-location', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;
    const { locationId, businessName, address, phone, website, accountName } = req.body;

    if (!locationId || !businessName) {
      res.status(400).json({ error: 'Missing locationId or businessName' });
      return;
    }

    try {
      // Get the active GBP connection
      const { data: connection, error: connError } = await supabase
        .from('growth_connected_accounts')
        .select('id')
        .eq('account_id', accountId)
        .eq('provider', 'google_business_profile')
        .eq('status', 'active')
        .eq('deleted', false)
        .maybeSingle();

      if (connError || !connection) {
        res.status(404).json({ error: 'No active GBP connection found.' });
        return;
      }

      // Update the connection with the selected location
      await supabase
        .from('growth_connected_accounts')
        .update({
          external_customer_id: locationId,
          display_name: businessName,
        })
        .eq('id', connection.id);

      // Create or update the GBP profile row
      const { data: existingProfile } = await supabase
        .from('growth_gbp_profile')
        .select('id')
        .eq('account_id', accountId)
        .eq('connection_id', connection.id)
        .maybeSingle();

      if (existingProfile) {
        await supabase
          .from('growth_gbp_profile')
          .update({
            location_id: locationId,
            gbp_account_name: accountName || null,
            business_name: businessName,
            address: address || null,
            phone: phone || null,
            website: website || null,
            deleted: false,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingProfile.id);
      } else {
        await supabase
          .from('growth_gbp_profile')
          .insert({
            account_id: accountId,
            connection_id: connection.id,
            location_id: locationId,
            gbp_account_name: accountName || null,
            business_name: businessName,
            address: address || null,
            phone: phone || null,
            website: website || null,
          });
      }

      console.log(`[GBP] Location selected: ${businessName} (${locationId}) for account=${accountId}`);
      res.json({ success: true, data: { locationId, businessName } });

    } catch (err) {
      console.error('[GBP] Error selecting location:', err);
      res.status(500).json({ error: 'Failed to save location selection.' });
    }
  });

  /**
   * GET /api/gbp/profile
   *
   * Returns the stored GBP profile for the current account.
   */
  router.get('/profile', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;

    try {
      const { data: profile, error } = await supabase
        .from('growth_gbp_profile')
        .select('*')
        .eq('account_id', accountId)
        .eq('deleted', false)
        .maybeSingle();

      if (error) {
        console.error('[GBP] Error fetching profile:', error);
        res.status(500).json({ error: 'Failed to fetch profile.' });
        return;
      }

      res.json({ success: true, data: { profile } });
    } catch (err) {
      console.error('[GBP] Unexpected error fetching profile:', err);
      res.status(500).json({ error: 'Failed to fetch profile.' });
    }
  });

  /**
   * POST /api/gbp/import-reviews
   *
   * Fetches reviews from the Google My Business API and upserts them
   * into the growth_gbp_reviews table. Also updates profile stats.
   */
  router.post('/import-reviews', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;

    try {
      // Get connection + profile
      const { data: profile, error: profError } = await supabase
        .from('growth_gbp_profile')
        .select('*, growth_connected_accounts!inner(id, encrypted_access_token, encrypted_refresh_token, status)')
        .eq('account_id', accountId)
        .eq('deleted', false)
        .maybeSingle();

      if (profError || !profile) {
        res.status(404).json({ error: 'No GBP profile found. Please select a location first.' });
        return;
      }

      const connection = (profile as any).growth_connected_accounts;
      let accessToken: string = connection.encrypted_access_token;

      if (!accessToken) {
        res.status(401).json({ error: 'No access token. Please reconnect.' });
        return;
      }

      const gbpAccountName = profile.gbp_account_name;
      const locationId = profile.location_id;

      if (!gbpAccountName) {
        // Fallback: discover account name by listing accounts and finding the one with this location
        const discovered = await discoverAccountName(accessToken, locationId, connection, supabase, config);
        if (!discovered) {
          res.status(400).json({ error: 'Could not determine GBP account. Please re-select your location.' });
          return;
        }
        // Store it for next time
        await supabase.from('growth_gbp_profile').update({ gbp_account_name: discovered.accountName }).eq('id', profile.id);
        accessToken = discovered.accessToken; // may have been refreshed
      }

      const effectiveAccountName = gbpAccountName || (await supabase.from('growth_gbp_profile').select('gbp_account_name').eq('id', profile.id).single()).data?.gbp_account_name;

      // Fetch reviews from Google My Business v4 API
      const reviewsUrl = `https://mybusiness.googleapis.com/v4/${effectiveAccountName}/${locationId}/reviews?pageSize=50`;

      let reviewsResponse = await fetch(reviewsUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      // Handle 401 — try refresh
      if (reviewsResponse.status === 401) {
        const refreshed = await refreshAccessToken(connection, supabase, config);
        if (!refreshed) {
          res.status(401).json({ error: 'Access token expired. Please reconnect.' });
          return;
        }
        accessToken = refreshed;
        reviewsResponse = await fetch(reviewsUrl, {
          headers: { 'Authorization': `Bearer ${refreshed}` },
        });
      }

      if (!reviewsResponse.ok) {
        const errBody = await reviewsResponse.text();
        console.error('[GBP] Failed to fetch reviews:', reviewsResponse.status, errBody);
        res.status(502).json({ error: 'Failed to fetch reviews from Google.' });
        return;
      }

      const reviewsData = await reviewsResponse.json() as {
        reviews?: Array<{
          name: string;
          reviewId: string;
          reviewer: { displayName?: string; profilePhotoUrl?: string };
          starRating: string;
          comment?: string;
          createTime: string;
          updateTime: string;
          reviewReply?: { comment: string; updateTime: string };
        }>;
        averageRating?: number;
        totalReviewCount?: number;
        nextPageToken?: string;
      };

      const reviews = reviewsData.reviews || [];
      console.log(`[GBP] Fetched ${reviews.length} reviews (total: ${reviewsData.totalReviewCount || 0})`);

      // Star rating enum to number
      const ratingMap: Record<string, number> = {
        ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
      };

      // Upsert reviews
      let imported = 0;
      for (const review of reviews) {
        const rating = ratingMap[review.starRating] || 0;
        const { error: upsertError } = await supabase
          .from('growth_gbp_reviews')
          .upsert({
            account_id: accountId,
            connection_id: connection.id,
            gbp_review_id: review.reviewId,
            author_name: review.reviewer?.displayName || null,
            rating,
            comment: review.comment || null,
            review_time: review.createTime,
            owner_reply: review.reviewReply?.comment || null,
            owner_reply_time: review.reviewReply?.updateTime || null,
          }, {
            onConflict: 'account_id,gbp_review_id',
            ignoreDuplicates: false,
          });

        if (upsertError) {
          console.warn('[GBP] Error upserting review:', upsertError.message);
        } else {
          imported++;
        }
      }

      // Update profile stats
      const avgRating = reviewsData.averageRating || 0;
      const totalReviews = reviewsData.totalReviewCount || reviews.length;

      await supabase
        .from('growth_gbp_profile')
        .update({
          total_reviews: totalReviews,
          average_rating: avgRating,
          last_imported_at: new Date().toISOString(),
        })
        .eq('id', profile.id);

      console.log(`[GBP] Imported ${imported} reviews for account=${accountId}`);
      res.json({
        success: true,
        data: {
          imported,
          totalReviews,
          averageRating: avgRating,
        },
      });

    } catch (err) {
      console.error('[GBP] Unexpected error importing reviews:', err);
      res.status(500).json({ error: 'Failed to import reviews.' });
    }
  });

  /**
   * POST /api/gbp/reviews/:reviewId/generate-reply
   *
   * Uses OpenAI to generate a professional reply draft for a review.
   * Stores the draft on the review row.
   */
  router.post('/reviews/:reviewId/generate-reply', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;
    const { reviewId } = req.params;

    try {
      // Get the review
      const { data: review, error: reviewError } = await supabase
        .from('growth_gbp_reviews')
        .select('*')
        .eq('id', reviewId)
        .eq('account_id', accountId)
        .eq('deleted', false)
        .single();

      if (reviewError || !review) {
        res.status(404).json({ error: 'Review not found.' });
        return;
      }

      // Get business name for context
      const { data: profile } = await supabase
        .from('growth_gbp_profile')
        .select('business_name')
        .eq('account_id', accountId)
        .eq('deleted', false)
        .maybeSingle();

      const businessName = profile?.business_name || 'our business';

      // Generate AI reply
      const openai = new OpenAI({ apiKey: config.openaiApiKey });

      const systemPrompt = `You are a friendly, professional reply writer for a painting contractor business called "${businessName}". 
Write a reply to a Google Business Profile review. 

Rules:
- Keep it concise (2-4 sentences max)
- Be genuine and warm, not corporate or robotic
- Thank the reviewer by first name if available
- For positive reviews (4-5 stars): express gratitude, mention you enjoy the work, invite them back
- For negative reviews (1-2 stars): apologize sincerely, show empathy, offer to make it right, provide a way to reach you directly
- For neutral reviews (3 stars): thank them, acknowledge feedback, express desire to improve
- Never be defensive or argumentative
- Don't use excessive exclamation marks
- Sign off casually (no need for a formal signature)`;

      const userPrompt = `Review from ${review.author_name || 'a customer'}:
Rating: ${review.rating}/5 stars
${review.comment ? `Comment: "${review.comment}"` : 'No written comment — rating only.'}

Write a reply:`;

      const completion = await openai.chat.completions.create({
        model: config.openaiModel || 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 300,
      });

      const aiDraft = completion.choices[0]?.message?.content?.trim();
      if (!aiDraft) {
        res.status(500).json({ error: 'AI returned empty response.' });
        return;
      }

      // Store the draft
      await supabase
        .from('growth_gbp_reviews')
        .update({
          ai_draft: aiDraft,
          ai_draft_generated_at: new Date().toISOString(),
          status: review.status === 'new' ? 'draft_generated' : review.status,
        })
        .eq('id', reviewId);

      console.log(`[GBP] AI reply generated for review ${reviewId}`);
      res.json({ success: true, data: { draft: aiDraft } });

    } catch (err) {
      console.error('[GBP] Error generating reply:', err);
      res.status(500).json({ error: 'Failed to generate reply.' });
    }
  });

  /**
   * POST /api/gbp/reviews/:reviewId/reply
   *
   * Posts the reply to Google and updates the local review row.
   */
  router.post('/reviews/:reviewId/reply', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;
    const { reviewId } = req.params;
    const { replyText } = req.body;

    if (!replyText || typeof replyText !== 'string' || replyText.trim().length === 0) {
      res.status(400).json({ error: 'replyText is required.' });
      return;
    }

    try {
      // Get review + connection
      const { data: review, error: reviewError } = await supabase
        .from('growth_gbp_reviews')
        .select('*, growth_connected_accounts!inner(id, encrypted_access_token, encrypted_refresh_token)')
        .eq('id', reviewId)
        .eq('account_id', accountId)
        .eq('deleted', false)
        .single();

      if (reviewError || !review) {
        res.status(404).json({ error: 'Review not found.' });
        return;
      }

      // Get profile for account name + location
      const { data: profile } = await supabase
        .from('growth_gbp_profile')
        .select('gbp_account_name, location_id')
        .eq('account_id', accountId)
        .eq('deleted', false)
        .maybeSingle();

      if (!profile?.gbp_account_name || !profile?.location_id) {
        res.status(400).json({ error: 'GBP account not fully configured.' });
        return;
      }

      const connection = (review as any).growth_connected_accounts;
      let accessToken: string = connection.encrypted_access_token;

      // Post reply to Google My Business v4 API
      const replyUrl = `https://mybusiness.googleapis.com/v4/${profile.gbp_account_name}/${profile.location_id}/reviews/${review.gbp_review_id}/reply`;

      let replyResponse = await fetch(replyUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ comment: replyText.trim() }),
      });

      // Handle 401 — refresh token
      if (replyResponse.status === 401) {
        const refreshed = await refreshAccessToken(connection, supabase, config);
        if (!refreshed) {
          res.status(401).json({ error: 'Token expired. Please reconnect.' });
          return;
        }
        accessToken = refreshed;
        replyResponse = await fetch(replyUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ comment: replyText.trim() }),
        });
      }

      if (!replyResponse.ok) {
        const errBody = await replyResponse.text();
        console.error('[GBP] Failed to post reply:', replyResponse.status, errBody);
        res.status(502).json({ error: 'Failed to post reply to Google.' });
        return;
      }

      // Update local review
      await supabase
        .from('growth_gbp_reviews')
        .update({
          owner_reply: replyText.trim(),
          owner_reply_time: new Date().toISOString(),
          replied_via_paintwiser: true,
          status: 'replied',
        })
        .eq('id', reviewId);

      console.log(`[GBP] Reply posted for review ${reviewId}`);
      res.json({ success: true });

    } catch (err) {
      console.error('[GBP] Error posting reply:', err);
      res.status(500).json({ error: 'Failed to post reply.' });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Discover account name (fallback for profiles created before accountName was stored)
// ---------------------------------------------------------------------------

async function discoverAccountName(
  accessToken: string,
  locationId: string,
  connection: { id: string; encrypted_refresh_token: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  config: Config
): Promise<{ accountName: string; accessToken: string } | null> {
  let token = accessToken;

  const accountsResponse = await fetch(`${GBP_ACCOUNT_API_BASE}/accounts`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (accountsResponse.status === 401) {
    const refreshed = await refreshAccessToken(connection, supabase, config);
    if (!refreshed) return null;
    token = refreshed;
    const retryResp = await fetch(`${GBP_ACCOUNT_API_BASE}/accounts`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!retryResp.ok) return null;
    const retryData = await retryResp.json() as { accounts?: Array<{ name: string }> };
    return findAccountForLocation(retryData.accounts || [], token, locationId);
  }

  if (!accountsResponse.ok) return null;
  const accountsData = await accountsResponse.json() as { accounts?: Array<{ name: string }> };
  const result = await findAccountForLocation(accountsData.accounts || [], token, locationId);
  return result ? { ...result, accessToken: token } : null;
}

async function findAccountForLocation(
  accounts: Array<{ name: string }>,
  accessToken: string,
  targetLocationId: string
): Promise<{ accountName: string; accessToken: string } | null> {
  for (const account of accounts) {
    const locResponse = await fetch(
      `${GBP_API_BASE}/${account.name}/locations?readMask=name`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (!locResponse.ok) continue;
    const locData = await locResponse.json() as { locations?: Array<{ name: string }> };
    for (const loc of locData.locations || []) {
      if (loc.name === targetLocationId) {
        return { accountName: account.name, accessToken };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token refresh helper
// ---------------------------------------------------------------------------

async function refreshAccessToken(
  connection: { id: string; encrypted_refresh_token: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  config: Config
): Promise<string | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.gbpClientId || config.googleAdsClientId,
        client_secret: config.gbpClientSecret || config.googleAdsClientSecret,
        refresh_token: connection.encrypted_refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      console.error('[GBP] Token refresh failed:', await response.text());
      // Mark connection as token_expired
      await supabase
        .from('growth_connected_accounts')
        .update({ status: 'token_expired', error_message: 'Token refresh failed' })
        .eq('id', connection.id);
      return null;
    }

    const data = await response.json() as {
      access_token: string;
      expires_in: number;
    };

    // Update stored tokens
    await supabase
      .from('growth_connected_accounts')
      .update({
        encrypted_access_token: data.access_token,
        token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
        last_refreshed_at: new Date().toISOString(),
      })
      .eq('id', connection.id);

    console.log(`[GBP] Access token refreshed for connection ${connection.id}`);
    return data.access_token;
  } catch (err) {
    console.error('[GBP] Token refresh error:', err);
    return null;
  }
}
