/**
 * Google Business Profile OAuth Routes
 *
 * Handles the OAuth 2.0 flow for users connecting their GBP accounts:
 *
 *   GET /oauth/google-gbp/start    — Redirects to Google consent screen (GBP scope only)
 *   GET /oauth/google-gbp/callback — Exchanges code for tokens, stores in Supabase
 *
 * IMPORTANT: This is independent from the Google Ads OAuth flow.
 * GBP uses its own scope (business.manage) and creates a separate row
 * in growth_connected_accounts with provider='google_business_profile'.
 *
 * A contractor may use a different Google account for GBP vs Ads.
 */

import { Router, Request, Response } from 'express';
import type { Config } from '../config.js';
import { createClient } from '@supabase/supabase-js';

// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// GBP API scope — only what we need, nothing more
const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';

// Where the user ends up after OAuth completes
const APP_SUCCESS_REDIRECT = 'https://app.paintwiser.com/growth/gbp';
const APP_SUCCESS_REDIRECT_DEV = 'http://localhost:8081/growth/gbp';

export function createGbpOAuthRouter(config: Config): Router {
  const router = Router();
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  // Determine callback URL based on environment
  const isLocalDev = process.env.NODE_ENV !== 'production' || process.env.DEV_BYPASS_AUTH === 'true';
  const baseUrl = isLocalDev
    ? `http://localhost:${config.port}`
    : 'https://growth.paintwiser.app';
  const callbackUrl = `${baseUrl}/oauth/google-gbp/callback`;

  /**
   * GET /oauth/google-gbp/start
   *
   * Starts the GBP OAuth flow. Requires accountId and userId as query params.
   * Redirects the user to Google's consent screen with GBP scope only.
   */
  router.get('/start', (req: Request, res: Response) => {
    const { accountId, userId } = req.query;

    if (!accountId || !userId) {
      res.status(400).json({ error: 'Missing accountId or userId query parameters' });
      return;
    }

    if (!config.googleAdsClientId) {
      // We reuse the same Google OAuth client credentials (client_id/secret)
      // but request a different scope. The client_id is the same Google Cloud project.
      res.status(500).json({ error: 'Google OAuth is not configured on the server' });
      return;
    }

    // Encode state as JSON — passed through Google and returned in callback
    const state = Buffer.from(JSON.stringify({
      accountId,
      userId,
      provider: 'google_business_profile',
      ts: Date.now(),
    })).toString('base64url');

    const params = new URLSearchParams({
      client_id: config.googleAdsClientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: GBP_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;
    console.log(`[OAuth-GBP] Starting GBP flow for account=${accountId}, user=${userId}`);
    res.redirect(authUrl);
  });

  /**
   * GET /oauth/google-gbp/callback
   *
   * Google redirects here after the user authorizes.
   * Exchanges the authorization code for tokens and stores them in Supabase
   * as a 'google_business_profile' provider connection.
   */
  router.get('/callback', async (req: Request, res: Response) => {
    const { code, state, error: oauthError } = req.query;

    // Handle user denial or errors
    if (oauthError) {
      console.error('[OAuth-GBP] Google returned error:', oauthError);
      const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
      res.redirect(`${redirectUrl}?error=access_denied`);
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: 'Missing code or state parameter' });
      return;
    }

    // Decode state
    let stateData: { accountId: string; userId: string; provider: string; ts: number };
    try {
      stateData = JSON.parse(Buffer.from(state as string, 'base64url').toString());
    } catch {
      res.status(400).json({ error: 'Invalid state parameter' });
      return;
    }

    const { accountId, userId } = stateData;
    console.log(`[OAuth-GBP] Callback received for account=${accountId}, user=${userId}`);

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
        console.error('[OAuth-GBP] Token exchange failed:', errBody);
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
        console.error('[OAuth-GBP] No refresh token received — user may have already authorized before');
        const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
        res.redirect(`${redirectUrl}?error=no_refresh_token`);
        return;
      }

      console.log(`[OAuth-GBP] Tokens received. Scope: ${tokens.scope}`);

      // Check for existing active GBP connection for this account
      const { data: existing } = await supabase
        .from('growth_connected_accounts')
        .select('id')
        .eq('account_id', accountId)
        .eq('provider', 'google_business_profile')
        .eq('status', 'active')
        .eq('deleted', false)
        .maybeSingle();

      if (existing) {
        // Update existing connection with new tokens
        const { error: updateError } = await supabase
          .from('growth_connected_accounts')
          .update({
            encrypted_refresh_token: tokens.refresh_token, // TODO: encrypt with pgcrypto in production
            encrypted_access_token: tokens.access_token,
            token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
            scopes: tokens.scope,
            status: 'active',
            error_message: null,
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);

        if (updateError) {
          console.error('[OAuth-GBP] Error updating connection:', updateError);
          const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
          res.redirect(`${redirectUrl}?error=storage_failed`);
          return;
        }
        console.log(`[OAuth-GBP] Updated existing connection ${existing.id}`);
      } else {
        // Create new GBP connection
        const { error: insertError } = await supabase
          .from('growth_connected_accounts')
          .insert({
            account_id: accountId,
            connected_by_user_id: userId,
            provider: 'google_business_profile',
            external_customer_id: null, // Will be set when user picks a location
            display_name: null,         // Will be set when user picks a location
            email: null,
            encrypted_refresh_token: tokens.refresh_token,
            encrypted_access_token: tokens.access_token,
            token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
            scopes: tokens.scope,
            status: 'active',
            connected_at: new Date().toISOString(),
          });

        if (insertError) {
          console.error('[OAuth-GBP] Error storing connection:', insertError);
          const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
          res.redirect(`${redirectUrl}?error=storage_failed`);
          return;
        }
        console.log(`[OAuth-GBP] Created new GBP connection for account=${accountId}`);
      }

      // Redirect back to the app — GBP page will show location picker
      const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
      res.redirect(`${redirectUrl}?connected=true`);

    } catch (err) {
      console.error('[OAuth-GBP] Unexpected error:', err);
      const redirectUrl = isLocalDev ? APP_SUCCESS_REDIRECT_DEV : APP_SUCCESS_REDIRECT;
      res.redirect(`${redirectUrl}?error=unexpected`);
    }
  });

  return router;
}
