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
    const { locationId, businessName, address, phone, website } = req.body;

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

  return router;
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
        client_id: config.googleAdsClientId,
        client_secret: config.googleAdsClientSecret,
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
