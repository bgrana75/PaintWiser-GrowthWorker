/**
 * PaintWiser Growth Worker — Express Server
 *
 * Docker container on Fly.io that powers the AI-driven market analysis
 * and campaign planning for the Growth module.
 *
 * Endpoints:
 *   GET  /health           — Health check (no auth)
 *   GET  /api/quota        — Check usage quota
 *   POST /api/analyze      — Run market analysis
 *   GET  /api/analyze/:id  — Get stored analysis
 *   POST /api/plan         — Generate campaign plan
 *   GET  /api/plan/:id     — Get stored plan
 */

import 'dotenv/config';
import express from 'express';
import { loadConfig } from './config.js';
import { initDb, getUsageQuota } from './db.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createUsageMiddleware } from './middleware/usage.js';
import { GooglePlacesCompetitorProvider, SerperCompetitorProvider, EstimateMarketDataProvider, GoogleAdsKeywordPlannerProvider, OpenAiLlmProvider } from './providers/index.js';
import type { MarketDataProvider } from './providers/interfaces.js';
import { MarketAnalysisService } from './services/market-analysis.js';
import { PlanGenerationService } from './services/plan-generation.js';
import { createAnalysisRouter } from './routes/analysis.js';
import { createPlanRouter } from './routes/plan.js';

async function main() {
  // Load config
  const config = loadConfig();
  console.log('[Growth Worker] Starting...');
  console.log(`[Growth Worker] SERP enabled: ${config.serpEnabled}`);
  console.log(`[Growth Worker] OpenAI model: ${config.openaiModel}`);

  // Initialize DB
  initDb(config);

  // Initialize providers — use real Keyword Planner if configured, with estimate fallback
  const useRealKeywordData = GoogleAdsKeywordPlannerProvider.isConfigured(config);
  const estimateProvider = new EstimateMarketDataProvider();
  let marketDataProvider: MarketDataProvider;
  if (useRealKeywordData) {
    const realProvider = new GoogleAdsKeywordPlannerProvider(config);
    // Wrap with fallback: try real, resort to estimates if empty/error
    marketDataProvider = {
      async getKeywordData(services, cities, state) {
        try {
          const realData = await realProvider.getKeywordData(services, cities, state);
          if (realData.length > 0) {
            console.log(`[Fallback] Using real Keyword Planner data (${realData.length} keywords)`);
            return realData;
          }
        } catch (err) {
          console.warn('[Fallback] Keyword Planner failed, using estimates:', err);
        }
        console.log('[Fallback] No real data — using template estimates');
        return estimateProvider.getKeywordData(services, cities, state);
      },
      setMarketFactor(f: number) {
        estimateProvider.setMarketFactor(f);
      },
    } as MarketDataProvider;
  } else {
    marketDataProvider = estimateProvider;
  }
  console.log(`[Growth Worker] Keyword data source: ${useRealKeywordData ? 'Google Ads Keyword Planner (REAL) with estimate fallback' : 'Template estimates (FALLBACK)'}`);
  const competitorProvider = new GooglePlacesCompetitorProvider(config);
  const serpProvider = config.serpEnabled ? new SerperCompetitorProvider(config) : null;
  const llmProvider = new OpenAiLlmProvider(config);

  // Initialize services
  const analysisService = new MarketAnalysisService({
    marketData: marketDataProvider,
    competitors: competitorProvider,
    serpProvider,
    llm: llmProvider,
  });

  const planService = new PlanGenerationService(llmProvider);

  // Create middleware
  const authMiddleware = createAuthMiddleware(config);
  const usageMiddleware = createUsageMiddleware();

  // Create Express app
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // CORS — allow frontend dev server and production origins
  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    const allowedOrigins = ['http://localhost:8081', 'http://localhost:19006', 'https://app.paintwiser.com', 'http://147.135.15.155:3002'];
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health check (no auth)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'growth-worker', timestamp: new Date().toISOString() });
  });

  // All API routes require auth
  app.use('/api', authMiddleware);

  // Quota check (auth only, no usage deduction)
  app.get('/api/quota', async (req, res) => {
    try {
      const quota = await getUsageQuota(req.auth!.accountId);
      res.json({ success: true, data: quota });
    } catch (err) {
      console.error('[Route] Quota check error:', err);
      res.status(500).json({ error: 'Failed to check quota' });
    }
  });

  // Analysis routes (auth + usage quota check)
  app.use('/api/analyze', usageMiddleware, createAnalysisRouter(analysisService));

  // Plan routes (auth + usage quota check)
  app.use('/api/plan', usageMiddleware, createPlanRouter(planService));

  // Start server
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[Growth Worker] Listening on port ${config.port}`);
  });
}

main().catch(err => {
  console.error('[Growth Worker] Fatal error:', err);
  process.exit(1);
});
