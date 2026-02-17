/**
 * Google Ads OAuth Routes
 *
 * Handles the OAuth 2.0 flow for users connecting their Google Ads accounts:
 *
 *   GET /oauth/google-ads/start    — Redirects to Google consent screen
 *   GET /oauth/google-ads/callback — Exchanges code for tokens, stores in Supabase
 *
 * These routes do NOT require auth middleware (the user authenticates with Google directly).
 * The accountId and userId are passed via query params on start and stored in the OAuth state.
 */

import { Router, Request, Response } from 'express';
import type { Config } from '../config.js';
import { createClient } from '@supabase/supabase-js';

// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Google Ads API scope
const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

// Where the user ends up after OAuth completes
const APP_SUCCESS_REDIRECT = 'https://app.paintwiser.com/growth/google-ads';
const APP_SUCCESS_REDIRECT_DEV = 'http://localhost:8081/growth/google-ads';

export function createOAuthRouter(config: Config): Router {
  const router = Router();
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  // Determine callback URL based on environment
  const isLocalDev = process.env.NODE_ENV !== 'production' || process.env.DEV_BYPASS_AUTH === 'true';
  const baseUrl = isLocalDev
    ? `http://localhost:${config.port}`
    : 'https://growth.paintwiser.app';
  const callbackUrl = `${baseUrl}/oauth/google-ads/callback`;

  /**
   * GET /oauth/google-ads/start
   *
   * Starts the OAuth flow. Requires accountId and userId as query params.
   * Redirects the user to Google's consent screen.
   */
  router.get('/start', (req: Request, res: Response) => {
    const { accountId, userId } = req.query;

    if (!accountId || !userId) {
      res.status(400).json({ error: 'Missing accountId or userId query parameters' });
      return;
    }

    if (!config.googleAdsClientId) {
      res.status(500).json({ error: 'Google Ads OAuth is not configured on the server' });
      return;
    }

    // Encode state as JSON — passed through Google and returned in callback
    const state = Buffer.from(JSON.stringify({
      accountId,
      userId,
      ts: Date.now(),
    })).toString('base64url');

    const params = new URLSearchParams({
      client_id: config.googleAdsClientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: GOOGLE_ADS_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;
    console.log(`[OAuth] Starting Google Ads flow for account=${accountId}, user=${userId}`);
    res.redirect(authUrl);
  });

  /**
   * GET /oauth/google-ads/callback
   *
   * Google redirects here after the user authorizes.
   * Exchanges the authorization code for tokens and stores them in Supabase.
   */
  router.get('/callback', async (req: Request, res: Response) => {
    const { code, state, error: oauthError } = req.query;

    // Handle user denial or errors
    if (oauthError) {
      console.error('[OAuth] Google returned error:', oauthError);
      const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
      res.redirect(`${redirectUrl}?error=access_denied`);
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: 'Missing code or state parameter' });
      return;
    }

    // Decode state
    let stateData: { accountId: string; userId: string; ts: number };
    try {
      stateData = JSON.parse(Buffer.from(state as string, 'base64url').toString());
    } catch {
      res.status(400).json({ error: 'Invalid state parameter' });
      return;
    }

    const { accountId, userId } = stateData;
    console.log(`[OAuth] Callback received for account=${accountId}, user=${userId}`);

    try {
      // Exchange authorization code for tokens
      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: code as string,
          client_id: config.googleAdsClientId,
          client_secret: config.googleAdsClientSecret,
          redirect_uri: callbackUrl,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        const errBody = await tokenResponse.text();
        console.error('[OAuth] Token exchange failed:', errBody);
        const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
        res.redirect(`${redirectUrl}?error=token_exchange_failed`);
        return;
      }

      const tokens = await tokenResponse.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        scope: string;
        token_type: string;
      };

      if (!tokens.refresh_token) {
        console.error('[OAuth] No refresh token received — user may have already authorized before');
        const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
        res.redirect(`${redirectUrl}?error=no_refresh_token`);
        return;
      }

      console.log(`[OAuth] Tokens received. Scope: ${tokens.scope}`);

      // Try to get the user's Google Ads customer ID(s) via the MCC
      let customerIds: string[] = [];
      let displayName: string | null = null;
      try {
        // Use the google-ads-api library to list accessible customers
        const { GoogleAdsApi } = await import('google-ads-api');
        const googleAds = new GoogleAdsApi({
          client_id: config.googleAdsClientId,
          client_secret: config.googleAdsClientSecret,
          developer_token: config.googleAdsDeveloperToken,
        });

        // listAccessibleCustomers is on the Client (GoogleAdsApi), not on Customer
        const accessible = await googleAds.listAccessibleCustomers(tokens.refresh_token);
        if (accessible && accessible.resource_names) {
          customerIds = accessible.resource_names.map(
            (rn: string) => rn.replace('customers/', '')
          );
          console.log(`[OAuth] Accessible customer IDs: ${customerIds.join(', ')}`);
        }
      } catch (err) {
        console.warn('[OAuth] Could not list accessible customers (expected with test token):', err);
        // This is expected with a test developer token — we'll still store the connection
      }

      // Pick the first non-MCC customer ID, or fall back to "pending"
      const externalCustomerId = customerIds.find(id => id !== config.googleAdsMccCustomerId) || customerIds[0] || 'pending';

      // Store connection in Supabase
      // First, check if there's an existing active connection for this account
      const { data: existing } = await supabase
        .from('growth_connected_accounts')
        .select('id')
        .eq('account_id', accountId)
        .eq('provider', 'google_ads')
        .eq('status', 'active')
        .eq('deleted', false)
        .maybeSingle();

      if (existing) {
        // Update the existing connection with new tokens
        const { error: updateError } = await supabase
          .from('growth_connected_accounts')
          .update({
            external_customer_id: externalCustomerId,
            encrypted_refresh_token: tokens.refresh_token, // TODO: encrypt in production
            encrypted_access_token: tokens.access_token,
            token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
            scopes: tokens.scope,
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);

        if (updateError) {
          console.error('[OAuth] Error updating connection:', updateError);
          const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
          res.redirect(`${redirectUrl}?error=storage_failed`);
          return;
        }
        console.log(`[OAuth] Updated existing connection ${existing.id}`);
      } else {
        // Create new connection
        const { error: insertError } = await supabase
          .from('growth_connected_accounts')
          .insert({
            account_id: accountId,
            connected_by_user_id: userId,
            provider: 'google_ads',
            external_customer_id: externalCustomerId,
            display_name: displayName,
            email: null,
            encrypted_refresh_token: tokens.refresh_token,
            encrypted_access_token: tokens.access_token,
            token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
            scopes: tokens.scope,
            status: 'active',
            connected_at: new Date().toISOString(),
          });

        if (insertError) {
          console.error('[OAuth] Error storing connection:', insertError);
          const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
          res.redirect(`${redirectUrl}?error=storage_failed`);
          return;
        }
        console.log(`[OAuth] Created new connection for account=${accountId}`);
      }

      // Redirect back to the app
      const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
      res.redirect(`${redirectUrl}?connected=true`);

    } catch (err) {
      console.error('[OAuth] Unexpected error:', err);
      const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
      res.redirect(`${redirectUrl}?error=unexpected`);
    }
  });

  return router;
}
