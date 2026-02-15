/**
 * Market Analysis Routes
 *
 * POST /api/analyze — Run full market analysis
 * GET  /api/analyze/:id — Get stored analysis result
 */

import { Router, type Request, type Response } from 'express';
import type { MarketAnalysisRequest } from '../types.js';
import { MarketAnalysisService } from '../services/market-analysis.js';
import { getDb } from '../db.js';

export function createAnalysisRouter(service: MarketAnalysisService): Router {
  const router = Router();

  /**
   * POST /api/analyze
   *
   * Body: MarketAnalysisRequest
   * Returns: MarketAnalysis
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const { accountId, userId } = req.auth!;

      // Validate request body
      const body = req.body as Partial<MarketAnalysisRequest>;
      if (!body.zipCode || !body.services?.length) {
        res.status(400).json({
          error: 'Missing required fields: zipCode and services[]',
        });
        return;
      }

      const request: MarketAnalysisRequest = {
        zipCode: body.zipCode,
        services: body.services,
        targetCities: body.targetCities || [],
        radiusMiles: body.radiusMiles || 25,
        websiteUrl: body.websiteUrl || undefined,
      };

      const analysis = await service.analyze(request, accountId, userId);

      res.json({ success: true, data: analysis });
    } catch (err) {
      console.error('[Route] Analysis error:', err);
      res.status(500).json({
        error: 'Market analysis failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/analyze/:id
   *
   * Returns a previously stored market analysis.
   */
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const { accountId } = req.auth!;
      const analysisId = req.params.id;

      const db = getDb();
      const { data, error } = await db
        .from('growth_market_analyses')
        .select('id, result_data, created_at')
        .eq('id', analysisId)
        .eq('account_id', accountId)
        .single();

      if (error || !data) {
        res.status(404).json({ error: 'Analysis not found' });
        return;
      }

      res.json({
        success: true,
        data: {
          id: data.id,
          ...data.result_data,
          createdAt: data.created_at,
        },
      });
    } catch (err) {
      console.error('[Route] Get analysis error:', err);
      res.status(500).json({ error: 'Failed to retrieve analysis' });
    }
  });

  return router;
}
