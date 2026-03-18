/**
 * Google Business Profile API Routes
 *
 * Authenticated endpoints for GBP operations:
 *
 *   GET  /api/gbp/locations                          — List accessible business locations
 *   POST /api/gbp/select-location                    — Select a location, create profile row
 *   GET  /api/gbp/profile                            — Get stored profile data
 *   POST /api/gbp/import-reviews                     — Import reviews from Google
 *   POST /api/gbp/reviews/:reviewId/generate-reply   — AI-draft a review reply
 *   POST /api/gbp/reviews/:reviewId/reply            — Post reply to Google
 *   POST /api/gbp/posts/generate                     — AI-draft a GBP post
 *   POST /api/gbp/posts/:postId/publish              — Publish draft post to Google
 *   POST /api/gbp/posts/:postId/dismiss              — Dismiss (soft-delete) a draft
 *   POST /api/gbp/import-metrics                      — Import daily performance metrics from Google
 *   GET  /api/gbp/profile/details                    — Fetch full location details from Google
 *   PATCH /api/gbp/update-profile                    — Push profile edits to Google + update local
 *
 * All routes require auth middleware (API key + JWT).
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

      // Soft-delete any old profiles from previous connections for this account
      await supabase
        .from('growth_gbp_profile')
        .update({ deleted: true })
        .eq('account_id', accountId)
        .neq('connection_id', connection.id)
        .eq('deleted', false);

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

  // =========================================================================
  // POSTS
  // =========================================================================

  /**
   * POST /api/gbp/posts/generate
   *
   * Uses OpenAI to generate a GBP post draft for the business.
   * Saves the draft to growth_gbp_posts with status='draft'.
   *
   * For tip/seasonal: also generates a DALL-E image and uploads to Supabase Storage.
   * For project_showcase: expects form data (jobType, location, description).
   *   Photos are uploaded separately by the app and the media_url is passed in.
   *
   * Body: {
   *   promptType: 'project_showcase'|'tip'|'seasonal'|'custom',
   *   customPrompt?: string,
   *   // Showcase-specific fields:
   *   jobType?: 'interior'|'exterior'|'both',
   *   location?: string,
   *   description?: string,
   *   mediaUrl?: string   // Already-uploaded photo URL
   * }
   */
  router.post('/posts/generate', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;
    const { promptType, customPrompt, jobType, location, description, mediaUrl } = req.body;

    const validTypes = ['project_showcase', 'tip', 'seasonal', 'custom'];
    if (!promptType || !validTypes.includes(promptType)) {
      res.status(400).json({ error: `promptType must be one of: ${validTypes.join(', ')}` });
      return;
    }

    if (promptType === 'custom' && (!customPrompt || typeof customPrompt !== 'string')) {
      res.status(400).json({ error: 'customPrompt is required for custom prompt type.' });
      return;
    }

    if (promptType === 'project_showcase') {
      if (!jobType || !['interior', 'exterior', 'both'].includes(jobType)) {
        res.status(400).json({ error: 'jobType (interior/exterior/both) is required for project showcase.' });
        return;
      }
      if (!location || typeof location !== 'string') {
        res.status(400).json({ error: 'location is required for project showcase.' });
        return;
      }
    }

    try {
      // Get profile + connection
      const { data: profile, error: profError } = await supabase
        .from('growth_gbp_profile')
        .select('*, growth_connected_accounts!inner(id)')
        .eq('account_id', accountId)
        .eq('deleted', false)
        .maybeSingle();

      if (profError || !profile) {
        res.status(404).json({ error: 'No GBP profile found.' });
        return;
      }

      const businessName = profile.business_name || 'our painting business';
      const connectionId = (profile as any).growth_connected_accounts.id;

      const openai = new OpenAI({ apiKey: config.openaiApiKey });

      // Fetch recent posts to avoid repeating themes
      const { data: recentPosts } = await supabase
        .from('growth_gbp_posts')
        .select('content, ai_prompt_type, created_at')
        .eq('account_id', accountId)
        .eq('deleted', false)
        .in('status', ['draft', 'published'])
        .order('created_at', { ascending: false })
        .limit(8);

      let recentPostsContext = '';
      if (recentPosts && recentPosts.length > 0) {
        const summaries = recentPosts.map((p, i) => {
          const snippet = p.content.substring(0, 120).replace(/\n/g, ' ');
          return `${i + 1}. [${p.ai_prompt_type || 'unknown'}] "${snippet}..."`;
        }).join('\n');
        recentPostsContext = `\n\nIMPORTANT — Here are the most recent posts already created. You MUST write about a DIFFERENT topic, angle, and approach. Do NOT repeat similar themes, tips, or talking points:\n${summaries}\n\nBe creative and explore a fresh angle that hasn't been covered recently.`;
      }

      const systemPrompt = `You are a social media content writer for a painting contractor business called "${businessName}".
Write a Google Business Profile post. These posts appear on Google Maps and Search, and help the business rank higher locally.

Rules:
- Keep it 100-250 words
- Be authentic and engaging, not salesy or robotic
- Use a friendly, professional tone
- Include a clear call-to-action at the end (e.g., "Call us for a free estimate!", "Book your consultation today!")
- Do NOT use hashtags (they don't work on GBP)
- Do NOT use emojis excessively (1-2 max if appropriate)
- Write in first person plural ("we", "our team")
- Focus on building trust and showcasing expertise
- Vary your writing style, opening lines, and structure from post to post
- Use different calls-to-action each time${recentPostsContext}`;

      // Build user prompt based on type
      let userPrompt: string;

      if (promptType === 'project_showcase') {
        const jobLabel = jobType === 'both' ? 'interior and exterior' : jobType;
        userPrompt = `Write a post showcasing a real ${jobLabel} painting project we just completed in ${location}.${description ? ` Details: ${description}` : ''} Describe the transformation and the client's satisfaction. Make it feel like a genuine project update from our team. Use a unique angle different from any previous showcase posts.`;
      } else if (promptType === 'custom') {
        userPrompt = `Write a Google Business Profile post based on this direction: "${customPrompt}"`;
      } else {
        const promptMap: Record<string, string> = {
          tip: `Write a helpful painting tip post. Share practical advice homeowners can use — things like how to choose the right paint finish, prep tips, maintenance advice, color selection guidance, or DIY vs professional considerations. Pick a specific, focused topic that hasn't been covered in recent posts. Position the business as an expert.`,
          seasonal: `Write a seasonal post relevant to the current time of year. Connect painting services to seasonal needs — spring refresh, summer exterior work, fall prep, holiday interior updates, weather considerations, or seasonal color trends. Find a unique seasonal angle that hasn't been used recently. Make it timely and actionable.`,
        };
        userPrompt = promptMap[promptType];
      }

      const completion = await openai.chat.completions.create({
        model: config.openaiModel || 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.9,
        max_tokens: 500,
      });

      const content = completion.choices[0]?.message?.content?.trim();
      if (!content) {
        res.status(500).json({ error: 'AI returned empty response.' });
        return;
      }

      // For tip/seasonal, generate a DALL-E image
      let finalMediaUrl: string | null = mediaUrl || null;

      if ((promptType === 'tip' || promptType === 'seasonal') && !finalMediaUrl) {
        try {
          // Vary image prompts for more diversity
          const tipScenes = [
            `A professional painter carefully applying paint to a wall with a roller, modern residential interior, bright natural lighting, beautiful color transformation. No text or logos.`,
            `Close-up of premium paint brushes and rollers alongside fresh paint cans, a beautifully painted accent wall visible in the background. Clean, professional setting. No text or logos.`,
            `A freshly painted living room with stunning before-and-after contrast, half the wall showing the old color. Professional painting equipment nearby. Natural light streaming in. No text or logos.`,
            `A professional painting team finishing a kitchen cabinet refinish project, modern kitchen with fresh white cabinets, warm lighting. No text or logos.`,
            `Exterior of a beautiful home with fresh vibrant paint, a professional painter on a ladder finishing trim work, clear blue sky. No text or logos.`,
          ];
          const seasonalScenes = [
            `A beautiful exterior of a freshly painted house in a suburban neighborhood during ${getCurrentSeason()}. Professional painting work visible, vibrant colors, warm lighting. No text or logos.`,
            `A cozy home interior freshly painted in warm ${getCurrentSeason()} tones, paint samples on a table, natural window light. No text or logos.`,
            `A stunning curb-appeal transformation of a ${getCurrentSeason()} home exterior, fresh paint in modern colors, professional finish. No text or logos.`,
          ];

          const scenes = promptType === 'tip' ? tipScenes : seasonalScenes;
          const imagePrompt = scenes[Math.floor(Math.random() * scenes.length)];

          console.log(`[GBP] Generating DALL-E image for ${promptType} post...`);

          const imageResponse = await openai.images.generate({
            model: 'dall-e-3',
            prompt: imagePrompt,
            n: 1,
            size: '1024x1024',
            quality: 'standard',
          });

          const dalleUrl = imageResponse.data?.[0]?.url;
          if (dalleUrl) {
            // Download the image and upload to Supabase Storage
            const imageRes = await fetch(dalleUrl);
            if (imageRes.ok) {
              const imageBuffer = await imageRes.arrayBuffer();
              const imageId = crypto.randomUUID();
              const storagePath = `${accountId}/${imageId}.jpg`;

              const { error: uploadError } = await supabase.storage
                .from('gbp-post-images')
                .upload(storagePath, imageBuffer, {
                  contentType: 'image/png',
                  upsert: true,
                });

              if (!uploadError) {
                const { data: publicUrlData } = supabase.storage
                  .from('gbp-post-images')
                  .getPublicUrl(storagePath);
                finalMediaUrl = publicUrlData.publicUrl;
                console.log(`[GBP] DALL-E image uploaded: ${finalMediaUrl}`);
              } else {
                console.warn('[GBP] Failed to upload DALL-E image:', uploadError.message);
              }
            }
          }
        } catch (imgErr) {
          console.warn('[GBP] DALL-E image generation failed (continuing without image):', imgErr);
        }
      }

      // Save as draft
      const { data: post, error: insertError } = await supabase
        .from('growth_gbp_posts')
        .insert({
          account_id: accountId,
          connection_id: connectionId,
          post_type: 'update',
          content,
          media_url: finalMediaUrl,
          source: 'ai_generated',
          ai_prompt_type: promptType,
          status: 'draft',
        })
        .select()
        .single();

      if (insertError) {
        console.error('[GBP] Error saving post draft:', insertError);
        res.status(500).json({ error: 'Failed to save post draft.' });
        return;
      }

      console.log(`[GBP] Post draft generated for account=${accountId}, type=${promptType}`);
      res.json({ success: true, data: { post } });

    } catch (err) {
      console.error('[GBP] Error generating post:', err);
      res.status(500).json({ error: 'Failed to generate post.' });
    }
  });

  /**
   * POST /api/gbp/posts/:postId/publish
   *
   * Publishes a draft post to Google Business Profile via the My Business v4 API.
   * Updates the local row with gbp_post_id, status='published', published_at.
   *
   * Body (optional): { content?: string } — to update content before publishing
   */
  router.post('/posts/:postId/publish', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;
    const { postId } = req.params;
    const { content: updatedContent } = req.body || {};

    try {
      // Get the post
      const { data: post, error: postError } = await supabase
        .from('growth_gbp_posts')
        .select('*')
        .eq('id', postId)
        .eq('account_id', accountId)
        .eq('deleted', false)
        .single();

      if (postError || !post) {
        res.status(404).json({ error: 'Post not found.' });
        return;
      }

      if (post.status === 'published') {
        res.status(400).json({ error: 'Post is already published.' });
        return;
      }

      const finalContent = (updatedContent && typeof updatedContent === 'string')
        ? updatedContent.trim()
        : post.content;

      if (!finalContent) {
        res.status(400).json({ error: 'Post content is empty.' });
        return;
      }

      // Get profile + connection
      const { data: profile, error: profError } = await supabase
        .from('growth_gbp_profile')
        .select('*, growth_connected_accounts!inner(id, encrypted_access_token, encrypted_refresh_token)')
        .eq('account_id', accountId)
        .eq('deleted', false)
        .maybeSingle();

      if (profError || !profile) {
        res.status(404).json({ error: 'No GBP profile found.' });
        return;
      }

      const connection = (profile as any).growth_connected_accounts;
      let accessToken: string = connection.encrypted_access_token;

      // Need account name + location
      let accountName = profile.gbp_account_name;
      const locationId = profile.location_id;

      if (!accountName) {
        const discovered = await discoverAccountName(accessToken, locationId, connection, supabase, config);
        if (!discovered) {
          res.status(400).json({ error: 'Could not determine GBP account. Please re-select your location.' });
          return;
        }
        accountName = discovered.accountName;
        accessToken = discovered.accessToken;
        await supabase.from('growth_gbp_profile').update({ gbp_account_name: accountName }).eq('id', profile.id);
      }

      // Build local post body for Google
      const localPostBody: Record<string, unknown> = {
        languageCode: 'en',
        summary: finalContent,
        topicType: 'STANDARD',
      };

      // Attach media (photo) if available
      const effectiveMediaUrl = post.media_url;
      if (effectiveMediaUrl) {
        localPostBody.media = [{
          mediaFormat: 'PHOTO',
          sourceUrl: effectiveMediaUrl,
        }];
      }

      // If there's a CTA
      if (post.cta_type && post.cta_type !== 'none' && post.cta_url) {
        const ctaActionMap: Record<string, string> = {
          call: 'CALL',
          learn_more: 'LEARN_MORE',
          book: 'BOOK',
        };
        localPostBody.callToAction = {
          actionType: ctaActionMap[post.cta_type] || 'LEARN_MORE',
          url: post.cta_url,
        };
      }

      // Publish to Google My Business v4 API
      const postUrl = `https://mybusiness.googleapis.com/v4/${accountName}/${locationId}/localPosts`;

      let postResponse = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(localPostBody),
      });

      // Handle 401 — refresh
      if (postResponse.status === 401) {
        const refreshed = await refreshAccessToken(connection, supabase, config);
        if (!refreshed) {
          res.status(401).json({ error: 'Token expired. Please reconnect.' });
          return;
        }
        accessToken = refreshed;
        postResponse = await fetch(postUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(localPostBody),
        });
      }

      if (!postResponse.ok) {
        const errBody = await postResponse.text();
        console.error('[GBP] Failed to publish post:', postResponse.status, errBody);
        res.status(502).json({ error: 'Failed to publish post to Google.' });
        return;
      }

      const publishedData = await postResponse.json() as { name?: string };
      const gbpPostId = publishedData.name || null; // e.g. "accounts/123/locations/456/localPosts/789"

      // Update local post
      await supabase
        .from('growth_gbp_posts')
        .update({
          content: finalContent,
          gbp_post_id: gbpPostId,
          status: 'published',
          published_at: new Date().toISOString(),
        })
        .eq('id', postId);

      console.log(`[GBP] Post published: ${postId} → ${gbpPostId}`);
      res.json({ success: true, data: { gbpPostId } });

    } catch (err) {
      console.error('[GBP] Error publishing post:', err);
      res.status(500).json({ error: 'Failed to publish post.' });
    }
  });

  /**
   * DELETE-style soft dismiss: POST /api/gbp/posts/:postId/dismiss
   *
   * Marks a draft post as dismissed (soft delete).
   */
  router.post('/posts/:postId/dismiss', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;
    const { postId } = req.params;

    try {
      const { error } = await supabase
        .from('growth_gbp_posts')
        .update({ status: 'dismissed', deleted: true })
        .eq('id', postId)
        .eq('account_id', accountId)
        .eq('deleted', false);

      if (error) {
        console.error('[GBP] Error dismissing post:', error);
        res.status(500).json({ error: 'Failed to dismiss post.' });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[GBP] Error dismissing post:', err);
      res.status(500).json({ error: 'Failed to dismiss post.' });
    }
  });

  // -------------------------------------------------------------------------
  // Metrics & Health Score
  // -------------------------------------------------------------------------

  /**
   * POST /api/gbp/import-metrics
   *
   * Fetches daily performance metrics from the Business Profile Performance API
   * for the last 30 days. Upserts into growth_gbp_metrics_daily.
   * Also recalculates the health score.
   */
  router.post('/import-metrics', async (req: Request, res: Response) => {
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

      const locationId = profile.location_id; // e.g. "locations/123456"

      // Date range: last 30 days
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - 30);

      const dailyMetrics = [
        'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
        'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
        'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
        'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
        'CALL_CLICKS',
        'WEBSITE_CLICKS',
        'BUSINESS_DIRECTION_REQUESTS',
      ];

      const params = new URLSearchParams();
      for (const m of dailyMetrics) {
        params.append('dailyMetrics', m);
      }
      params.set('dailyRange.startDate.year', String(startDate.getFullYear()));
      params.set('dailyRange.startDate.month', String(startDate.getMonth() + 1));
      params.set('dailyRange.startDate.day', String(startDate.getDate()));
      params.set('dailyRange.endDate.year', String(endDate.getFullYear()));
      params.set('dailyRange.endDate.month', String(endDate.getMonth() + 1));
      params.set('dailyRange.endDate.day', String(endDate.getDate()));

      const perfUrl = `https://businessprofileperformance.googleapis.com/v1/${locationId}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`;
      console.log('[GBP] Fetching performance metrics from:', perfUrl);

      let perfResponse = await fetch(perfUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      // Handle 401 — try refresh
      if (perfResponse.status === 401) {
        const refreshed = await refreshAccessToken(connection, supabase, config);
        if (!refreshed) {
          res.status(401).json({ error: 'Access token expired. Please reconnect.' });
          return;
        }
        accessToken = refreshed;
        perfResponse = await fetch(perfUrl, {
          headers: { 'Authorization': `Bearer ${refreshed}` },
        });
      }

      if (!perfResponse.ok) {
        const errBody = await perfResponse.text();
        console.error('[GBP] Failed to fetch performance metrics:', perfResponse.status, errBody);
        res.status(502).json({ error: 'Failed to fetch metrics from Google.' });
        return;
      }

      const perfRawText = await perfResponse.text();
      console.log('[GBP] Performance API response status:', perfResponse.status);
      console.log('[GBP] Performance API response body (first 1000 chars):', perfRawText.substring(0, 1000));

      let perfData: any;
      try {
        perfData = JSON.parse(perfRawText);
      } catch {
        console.error('[GBP] Failed to parse performance API response');
        res.status(502).json({ error: 'Invalid response from Google Performance API.' });
        return;
      }

      // Build a day-indexed map: { "2025-03-01": { views_maps: X, views_search: Y, ... } }
      const dayMap: Record<string, {
        views_maps: number;
        views_search: number;
        actions_calls: number;
        actions_directions: number;
        actions_website: number;
      }> = {};

      for (const series of perfData.multiDailyMetricTimeSeries || []) {
        // dailyMetricTimeSeries is an array of { dailyMetric, timeSeries }
        const innerSeries = Array.isArray(series.dailyMetricTimeSeries)
          ? series.dailyMetricTimeSeries
          : [series.dailyMetricTimeSeries];

        for (const ts of innerSeries) {
          const metric = ts.dailyMetric;
          const values = ts.timeSeries?.datedValues || [];

          for (const dv of values) {
            const dateStr = `${dv.date.year}-${String(dv.date.month).padStart(2, '0')}-${String(dv.date.day).padStart(2, '0')}`;
            if (!dayMap[dateStr]) {
              dayMap[dateStr] = { views_maps: 0, views_search: 0, actions_calls: 0, actions_directions: 0, actions_website: 0 };
            }
            const val = parseInt(dv.value || '0', 10) || 0;

            switch (metric) {
              case 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS':
              case 'BUSINESS_IMPRESSIONS_MOBILE_MAPS':
                dayMap[dateStr].views_maps += val;
                break;
              case 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH':
              case 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH':
                dayMap[dateStr].views_search += val;
                break;
              case 'CALL_CLICKS':
                dayMap[dateStr].actions_calls += val;
                break;
              case 'BUSINESS_DIRECTION_REQUESTS':
                dayMap[dateStr].actions_directions += val;
                break;
              case 'WEBSITE_CLICKS':
                dayMap[dateStr].actions_website += val;
                break;
            }
          }
        }
      }

      // Upsert daily metrics
      let imported = 0;
      for (const [date, metrics] of Object.entries(dayMap)) {
        const { error: upsertError } = await supabase
          .from('growth_gbp_metrics_daily')
          .upsert({
            account_id: accountId,
            connection_id: connection.id,
            date,
            views_maps: metrics.views_maps,
            views_search: metrics.views_search,
            searches_direct: 0,
            searches_discovery: 0,
            actions_calls: metrics.actions_calls,
            actions_directions: metrics.actions_directions,
            actions_website: metrics.actions_website,
          }, {
            onConflict: 'account_id,connection_id,date',
            ignoreDuplicates: false,
          });

        if (upsertError) {
          console.warn('[GBP] Error upserting metric row:', upsertError.message);
        } else {
          imported++;
        }
      }

      // Calculate health score
      const healthScore = await calculateHealthScore(accountId, connection.id, profile, supabase);

      // Update profile with health score
      await supabase
        .from('growth_gbp_profile')
        .update({
          health_score: healthScore,
          health_last_calculated: new Date().toISOString(),
        })
        .eq('id', profile.id);

      console.log(`[GBP] Imported ${imported} metric days, health score: ${healthScore} for account=${accountId}`);
      res.json({
        success: true,
        data: {
          imported,
          daysWithData: Object.keys(dayMap).length,
          healthScore,
        },
      });

    } catch (err) {
      console.error('[GBP] Unexpected error importing metrics:', err);
      res.status(500).json({ error: 'Failed to import metrics.' });
    }
  });

  // -------------------------------------------------------------------------
  // Profile editing
  // -------------------------------------------------------------------------

  /**
   * GET /api/gbp/profile/details
   *
   * Fetches the full location details from Google (hours, description, etc.)
   * and returns them so the edit form can be populated with live data.
   */
  router.get('/profile/details', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;

    try {
      const { data: profile, error: profError } = await supabase
        .from('growth_gbp_profile')
        .select('*, growth_connected_accounts!inner(id, encrypted_access_token, encrypted_refresh_token)')
        .eq('account_id', accountId)
        .eq('deleted', false)
        .maybeSingle();

      if (profError || !profile) {
        res.status(404).json({ error: 'No GBP profile found.' });
        return;
      }

      const connection = (profile as any).growth_connected_accounts;
      let accessToken: string = connection.encrypted_access_token;
      const locationId = profile.location_id;

      if (!accessToken) {
        res.status(401).json({ error: 'No access token. Please reconnect.' });
        return;
      }

      // Fetch full location details from Google Business Information API v1
      const readMask = 'name,title,storefrontAddress,phoneNumbers,websiteUri,regularHours,profile';
      let detailsResponse = await fetch(
        `${GBP_API_BASE}/${locationId}?readMask=${readMask}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );

      if (detailsResponse.status === 401) {
        const refreshed = await refreshAccessToken(connection, supabase, config);
        if (!refreshed) {
          res.status(401).json({ error: 'Token expired. Please reconnect.' });
          return;
        }
        accessToken = refreshed;
        detailsResponse = await fetch(
          `${GBP_API_BASE}/${locationId}?readMask=${readMask}`,
          { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
      }

      if (!detailsResponse.ok) {
        const errBody = await detailsResponse.text();
        console.error('[GBP] Failed to fetch location details:', detailsResponse.status, errBody);
        res.status(502).json({ error: 'Failed to fetch profile details from Google.' });
        return;
      }

      const location = await detailsResponse.json() as {
        name?: string;
        title?: string;
        storefrontAddress?: {
          addressLines?: string[];
          locality?: string;
          administrativeArea?: string;
          postalCode?: string;
        };
        phoneNumbers?: { primaryPhone?: string };
        websiteUri?: string;
        regularHours?: {
          periods?: Array<{
            openDay: string;
            openTime: { hours?: number; minutes?: number };
            closeDay: string;
            closeTime: { hours?: number; minutes?: number };
          }>;
        };
        profile?: { description?: string };
      };

      // Convert Google's regularHours to a simpler format for the frontend
      const hours: Record<string, { open: boolean; openTime: string; closeTime: string }> = {};
      const dayNames = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
      const dayKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

      // Initialize all days as closed
      for (const day of dayKeys) {
        hours[day] = { open: false, openTime: '09:00', closeTime: '17:00' };
      }

      // Fill in from Google data
      if (location.regularHours?.periods) {
        for (const period of location.regularHours.periods) {
          const dayIndex = dayNames.indexOf(period.openDay);
          if (dayIndex >= 0) {
            const dayKey = dayKeys[dayIndex];
            const openH = String(period.openTime?.hours || 0).padStart(2, '0');
            const openM = String(period.openTime?.minutes || 0).padStart(2, '0');
            const closeH = String(period.closeTime?.hours || 0).padStart(2, '0');
            const closeM = String(period.closeTime?.minutes || 0).padStart(2, '0');
            hours[dayKey] = {
              open: true,
              openTime: `${openH}:${openM}`,
              closeTime: `${closeH}:${closeM}`,
            };
          }
        }
      }

      // Update local profile with fresh data from Google
      const addr = location.storefrontAddress;
      const addressStr = addr
        ? [...(addr.addressLines || []), addr.locality, addr.administrativeArea, addr.postalCode]
            .filter(Boolean)
            .join(', ')
        : profile.address;

      await supabase
        .from('growth_gbp_profile')
        .update({
          business_name: location.title || profile.business_name,
          address: addressStr,
          phone: location.phoneNumbers?.primaryPhone || profile.phone,
          website: location.websiteUri || profile.website,
          description: location.profile?.description || profile.description,
          hours,
        })
        .eq('id', profile.id);

      res.json({
        success: true,
        data: {
          business_name: location.title || profile.business_name,
          address: addressStr,
          phone: location.phoneNumbers?.primaryPhone || profile.phone,
          website: location.websiteUri || profile.website,
          description: location.profile?.description || profile.description,
          hours,
          scheduling_url: profile.scheduling_url || null,
        },
      });

    } catch (err) {
      console.error('[GBP] Error fetching profile details:', err);
      res.status(500).json({ error: 'Failed to fetch profile details.' });
    }
  });

  /**
   * PATCH /api/gbp/update-profile
   *
   * Pushes profile edits to Google Business Profile + updates local DB.
   * Body: { phone?, website?, description?, hours?, schedulingUrl? }
   *
   * - phone, website, description, hours → pushed to Google via Business Information API v1
   * - schedulingUrl → stored locally only (used as default CTA for posts)
   */
  router.patch('/update-profile', async (req: Request, res: Response) => {
    const { accountId } = req.auth!;
    const { phone, website, description, hours, schedulingUrl } = req.body || {};

    try {
      const { data: profile, error: profError } = await supabase
        .from('growth_gbp_profile')
        .select('*, growth_connected_accounts!inner(id, encrypted_access_token, encrypted_refresh_token)')
        .eq('account_id', accountId)
        .eq('deleted', false)
        .maybeSingle();

      if (profError || !profile) {
        res.status(404).json({ error: 'No GBP profile found.' });
        return;
      }

      const connection = (profile as any).growth_connected_accounts;
      let accessToken: string = connection.encrypted_access_token;
      const locationId = profile.location_id;

      // Build the Google API update body + updateMask
      const updateBody: Record<string, unknown> = {};
      const updateMaskParts: string[] = [];

      if (phone !== undefined) {
        updateBody.phoneNumbers = { primaryPhone: phone || '' };
        updateMaskParts.push('phoneNumbers.primaryPhone');
      }

      if (website !== undefined) {
        updateBody.websiteUri = website || '';
        updateMaskParts.push('websiteUri');
      }

      if (description !== undefined) {
        updateBody.profile = { description: description || '' };
        updateMaskParts.push('profile.description');
      }

      if (hours && typeof hours === 'object') {
        // Convert our format to Google's regularHours format
        const dayNames = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
        const dayKeys = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const periods: Array<{
          openDay: string;
          openTime: { hours: number; minutes: number };
          closeDay: string;
          closeTime: { hours: number; minutes: number };
        }> = [];

        for (let i = 0; i < dayKeys.length; i++) {
          const dayData = hours[dayKeys[i]];
          if (dayData?.open) {
            const [openH, openM] = (dayData.openTime || '09:00').split(':').map(Number);
            const [closeH, closeM] = (dayData.closeTime || '17:00').split(':').map(Number);
            periods.push({
              openDay: dayNames[i],
              openTime: { hours: openH, minutes: openM },
              closeDay: dayNames[i],
              closeTime: { hours: closeH, minutes: closeM },
            });
          }
        }

        updateBody.regularHours = { periods };
        updateMaskParts.push('regularHours');
      }

      // Push to Google if there are changes to push
      if (updateMaskParts.length > 0) {
        const updateMask = updateMaskParts.join(',');
        const updateUrl = `${GBP_API_BASE}/${locationId}?updateMask=${updateMask}`;

        let updateResponse = await fetch(updateUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updateBody),
        });

        if (updateResponse.status === 401) {
          const refreshed = await refreshAccessToken(connection, supabase, config);
          if (!refreshed) {
            res.status(401).json({ error: 'Token expired. Please reconnect.' });
            return;
          }
          accessToken = refreshed;
          updateResponse = await fetch(updateUrl, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(updateBody),
          });
        }

        if (!updateResponse.ok) {
          const errBody = await updateResponse.text();
          console.error('[GBP] Failed to update profile on Google:', updateResponse.status, errBody);
          res.status(502).json({ error: 'Failed to update profile on Google. Changes not saved.' });
          return;
        }

        console.log(`[GBP] Profile updated on Google for account=${accountId}, fields: ${updateMask}`);
      }

      // Update local Supabase profile
      const localUpdate: Record<string, unknown> = {};
      if (phone !== undefined) localUpdate.phone = phone;
      if (website !== undefined) localUpdate.website = website;
      if (description !== undefined) localUpdate.description = description;
      if (hours !== undefined) localUpdate.hours = hours;
      if (schedulingUrl !== undefined) localUpdate.scheduling_url = schedulingUrl;

      if (Object.keys(localUpdate).length > 0) {
        await supabase
          .from('growth_gbp_profile')
          .update(localUpdate)
          .eq('id', profile.id);
      }

      res.json({ success: true });

    } catch (err) {
      console.error('[GBP] Error updating profile:', err);
      res.status(500).json({ error: 'Failed to update profile.' });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Season helper for seasonal post prompts
// ---------------------------------------------------------------------------

function getCurrentSeason(): string {
  const month = new Date().getMonth(); // 0-11
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'fall';
  return 'winter';
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

// ---------------------------------------------------------------------------
// Health score calculation
// ---------------------------------------------------------------------------

async function calculateHealthScore(
  accountId: string,
  connectionId: string,
  profile: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
): Promise<number> {
  let score = 0;

  // 1. Profile completeness (up to 30 points)
  const completenessChecks = [
    { field: profile.phone, points: 5 },
    { field: profile.website, points: 5 },
    { field: profile.description, points: 8 },
    { field: profile.hours && Object.keys(profile.hours || {}).length > 0, points: 7 },
    { field: profile.scheduling_url, points: 5 },
  ];
  for (const check of completenessChecks) {
    if (check.field) score += check.points;
  }

  // 2. Review response rate (up to 25 points)
  const { count: totalReviews } = await supabase
    .from('growth_gbp_reviews')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('deleted', false);

  const { count: repliedReviews } = await supabase
    .from('growth_gbp_reviews')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('deleted', false)
    .not('owner_reply', 'is', null);

  if (totalReviews && totalReviews > 0) {
    const responseRate = (repliedReviews || 0) / totalReviews;
    score += Math.round(responseRate * 25);
  }

  // 3. Post frequency — posts in last 30 days (up to 25 points)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const { count: recentPosts } = await supabase
    .from('growth_gbp_posts')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('status', 'published')
    .eq('deleted', false)
    .gte('published_at', thirtyDaysAgo.toISOString());

  // 4+ posts/month = full points, scale linearly
  const postScore = Math.min((recentPosts || 0) / 4, 1) * 25;
  score += Math.round(postScore);

  // 4. Activity trends — views in last 14 days vs previous 14 days (up to 20 points)
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const twentyEightDaysAgo = new Date();
  twentyEightDaysAgo.setDate(twentyEightDaysAgo.getDate() - 28);

  const { data: recentMetrics } = await supabase
    .from('growth_gbp_metrics_daily')
    .select('views_maps, views_search')
    .eq('account_id', accountId)
    .eq('connection_id', connectionId)
    .eq('deleted', false)
    .gte('date', fourteenDaysAgo.toISOString().split('T')[0]);

  const { data: priorMetrics } = await supabase
    .from('growth_gbp_metrics_daily')
    .select('views_maps, views_search')
    .eq('account_id', accountId)
    .eq('connection_id', connectionId)
    .eq('deleted', false)
    .gte('date', twentyEightDaysAgo.toISOString().split('T')[0])
    .lt('date', fourteenDaysAgo.toISOString().split('T')[0]);

  const recentViews = (recentMetrics || []).reduce((sum: number, m: any) => sum + (m.views_maps || 0) + (m.views_search || 0), 0);
  const priorViews = (priorMetrics || []).reduce((sum: number, m: any) => sum + (m.views_maps || 0) + (m.views_search || 0), 0);

  if (recentViews > 0) {
    // Base 10 points for having any views, +10 if trending up
    score += 10;
    if (priorViews > 0 && recentViews >= priorViews) {
      score += 10;
    } else if (priorViews === 0) {
      // No prior data to compare — give benefit of the doubt
      score += 5;
    }
  }

  return Math.min(score, 100);
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
