/**
 * Supabase DB Client + CRM Data Queries
 *
 * Uses service_role key to read CRM data (quotes, invoices, customers)
 * for the requesting account. No TinyBase — all reads from Supabase directly.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config.js';
import type { CrmSnapshot, CrmServiceBreakdown, CrmCityCount, UsageQuota } from './types.js';

/** Monthly analysis quota per account. TODO: make this per-account in DB */
const DEFAULT_MONTHLY_QUOTA = 10;

/** CRM lookback period in months */
const CRM_LOOKBACK_MONTHS = 12;

/** Max top cities to return in CRM snapshot */
const MAX_TOP_CITIES = 10;

let supabase: SupabaseClient;

export function initDb(config: Config): void {
  supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function getDb(): SupabaseClient {
  if (!supabase) throw new Error('DB not initialized — call initDb() first');
  return supabase;
}

/**
 * Build a CRM snapshot from the account's quotes and invoices.
 * This gives the LLM context about what services perform well,
 * win rates, average deal sizes, and which cities are active.
 */
export async function getCrmSnapshot(accountId: string): Promise<CrmSnapshot | null> {
  const db = getDb();

  // Fetch quotes with areas (for service type)
  // Note: property_id has no FK constraint so we can't do an embedded join.
  // We fetch quotes + areas first, then fetch properties separately.
  const lookbackDate = new Date();
  lookbackDate.setMonth(lookbackDate.getMonth() - CRM_LOOKBACK_MONTHS);

  const { data: quotes, error: quotesErr } = await db
    .from('quotes')
    .select(`
      id, status, total_price, property_id, created_at,
      quote_areas ( type )
    `)
    .eq('account_id', accountId)
    .eq('deleted', false)
    .gte('created_at', lookbackDate.toISOString());

  if (quotesErr) {
    console.error('[CRM] Error fetching quotes:', quotesErr.message);
    return null;
  }

  if (!quotes || quotes.length === 0) {
    return null; // No CRM data available
  }

  // Fetch properties for city/state (separate query since no FK constraint)
  const propertyIds = [...new Set((quotes as any[]).map(q => q.property_id).filter(Boolean))];
  let propertyMap = new Map<string, { city: string; state: string }>();

  if (propertyIds.length > 0) {
    const { data: properties, error: propErr } = await db
      .from('properties')
      .select('id, city, state')
      .in('id', propertyIds);

    if (!propErr && properties) {
      for (const p of properties) {
        if (p.city) {
          propertyMap.set(p.id, { city: p.city, state: p.state || '' });
        }
      }
    }
  }

  // Aggregate by service type (from quote_areas.type)
  const serviceMap = new Map<string, { quotes: number; won: number; totalRevenue: number }>();
  for (const q of quotes as any[]) {
    // Collect unique area types from this quote
    const areaTypes: string[] = (q.quote_areas || [])
      .map((a: any) => a.type)
      .filter((t: string) => !!t);
    const serviceTypes = [...new Set(areaTypes)];
    if (serviceTypes.length === 0) serviceTypes.push('Unknown');

    const isWon = q.status === 'approved' || q.status === 'completed';
    const revenue = Number(q.total_price) || 0;

    for (const svc of serviceTypes) {
      const entry = serviceMap.get(svc) || { quotes: 0, won: 0, totalRevenue: 0 };
      entry.quotes++;
      if (isWon) {
        entry.won++;
        entry.totalRevenue += revenue / serviceTypes.length; // Split revenue across services
      }
      serviceMap.set(svc, entry);
    }
  }

  const serviceBreakdown: CrmServiceBreakdown[] = Array.from(serviceMap.entries())
    .map(([service, data]) => ({
      service,
      quoteCount: data.quotes,
      winRate: data.quotes > 0 ? Math.round((data.won / data.quotes) * 100) / 100 : 0,
      avgDealSize: data.won > 0 ? Math.round(data.totalRevenue / data.won) : 0,
      totalRevenue: Math.round(data.totalRevenue),
    }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue);

  // Aggregate by city (from properties lookup)
  const cityMap = new Map<string, number>();
  for (const q of quotes as any[]) {
    const prop = propertyMap.get(q.property_id);
    if (prop?.city) {
      const key = prop.state ? `${prop.city}, ${prop.state}` : prop.city;
      cityMap.set(key, (cityMap.get(key) || 0) + 1);
    }
  }

  const topCities: CrmCityCount[] = Array.from(cityMap.entries())
    .map(([city, count]) => ({ city, quoteCount: count }))
    .sort((a, b) => b.quoteCount - a.quoteCount)
    .slice(0, MAX_TOP_CITIES);

  // Totals
  const totalQuotes = quotes.length;
  const wonQuotes = (quotes as any[]).filter(q => q.status === 'approved' || q.status === 'completed').length;
  const totalRevenue = serviceBreakdown.reduce((sum, s) => sum + s.totalRevenue, 0);

  return {
    totalQuotes,
    wonQuotes,
    totalRevenue,
    avgDealSize: wonQuotes > 0 ? Math.round(totalRevenue / wonQuotes) : 0,
    serviceBreakdown,
    topCities,
  };
}

/**
 * Check usage quota for an account.
 */
export async function getUsageQuota(accountId: string): Promise<UsageQuota> {
  const db = getDb();
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  // Count analysis events this month
  const { count, error } = await db
    .from('growth_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('created_at', startOfMonth);

  if (error) {
    console.error('[Usage] CRITICAL: Error checking quota:', error.message);
    // Fail closed — deny access when we can't verify quota
    return { used: DEFAULT_MONTHLY_QUOTA, limit: DEFAULT_MONTHLY_QUOTA, remaining: 0, periodStart: startOfMonth, periodEnd: '' };
  }

  const limit = DEFAULT_MONTHLY_QUOTA;
  const used = count || 0;

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    periodStart: startOfMonth,
    periodEnd: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString(),
  };
}

/**
 * Log a usage event (analysis or plan generation).
 */
export async function logUsageEvent(
  accountId: string,
  userId: string,
  eventType: string,
  metadata?: Record<string, any>,
): Promise<void> {
  const db = getDb();

  const { error } = await db
    .from('growth_usage_log')
    .insert({
      account_id: accountId,
      user_id: userId,
      event_type: eventType,
      metadata: metadata || {},
    });

  if (error) {
    console.error('[Usage] Error logging event:', error.message);
  }
}

/**
 * Store a market analysis result for the account.
 */
export async function saveMarketAnalysis(
  accountId: string,
  userId: string,
  requestData: Record<string, any>,
  resultData: Record<string, any>,
): Promise<string | null> {
  const db = getDb();

  const { data, error } = await db
    .from('growth_market_analyses')
    .insert({
      account_id: accountId,
      user_id: userId,
      request_data: requestData,
      result_data: resultData,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[DB] Error saving analysis:', error.message);
    return null;
  }

  return data?.id || null;
}

/**
 * Store a campaign plan.
 */
export async function saveCampaignPlan(
  accountId: string,
  userId: string,
  analysisId: string,
  planData: Record<string, any>,
): Promise<string | null> {
  const db = getDb();

  const { data, error } = await db
    .from('growth_campaign_plans')
    .insert({
      account_id: accountId,
      user_id: userId,
      analysis_id: analysisId,
      plan_data: planData,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[DB] Error saving plan:', error.message);
    return null;
  }

  return data?.id || null;
}
