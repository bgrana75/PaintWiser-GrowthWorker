/**
 * Configuration — loaded from environment variables.
 */

export interface Config {
  port: number;
  growthApiKey: string;

  // Supabase
  supabaseUrl: string;
  supabaseServiceRoleKey: string;

  // LLM
  llmProvider: 'openai';
  openaiApiKey: string;
  openaiModel: string;

  // Google
  googlePlacesApiKey: string;
  googleAdsDeveloperToken: string;
  googleAdsClientId: string;
  googleAdsClientSecret: string;
  googleAdsRefreshToken: string;
  googleAdsMccCustomerId: string;

  // Serper (Phase 2)
  serperApiKey: string;
  serpEnabled: boolean;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3002', 10),
    growthApiKey: process.env.GROWTH_API_KEY || '',

    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

    llmProvider: 'openai',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',

    googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || '',
    googleAdsDeveloperToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
    googleAdsClientId: process.env.GOOGLE_ADS_CLIENT_ID || '',
    googleAdsClientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET || '',
    googleAdsRefreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN || '',
    googleAdsMccCustomerId: (process.env.GOOGLE_ADS_MCC_CUSTOMER_ID || '').replace(/-/g, ''),

    serperApiKey: process.env.SERPER_API_KEY || '',
    serpEnabled: process.env.GROWTH_SERP_ENABLED === 'true',
  };
}
