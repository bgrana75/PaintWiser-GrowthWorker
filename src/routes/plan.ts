/**
 * Plan Generation Routes
 *
 * POST /api/plan — Generate campaign plan from analysis
 * GET  /api/plan/:id — Get stored campaign plan
 */

import { Router, type Request, type Response } from 'express';
import type { PlanGenerationRequest } from '../types.js';
import { PlanGenerationService } from '../services/plan-generation.js';
import { getDb } from '../db.js';

export function createPlanRouter(service: PlanGenerationService): Router {
  const router = Router();

  /**
   * POST /api/plan
   *
   * Body: PlanGenerationRequest
   * Returns: CampaignPlan
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const { accountId, userId } = req.auth!;

      const body = req.body as Partial<PlanGenerationRequest>;
      if (!body.analysisId || !body.selectedServices?.length || !body.selectedCities?.length) {
        res.status(400).json({
          error: 'Missing required fields: analysisId, selectedServices[], selectedCities[]',
        });
        return;
      }

      if (!body.dailyBudget || !body.hardCap) {
        res.status(400).json({
          error: 'Missing required fields: dailyBudget, hardCap',
        });
        return;
      }

      const request: PlanGenerationRequest = {
        analysisId: body.analysisId,
        selectedServices: body.selectedServices,
        selectedCities: body.selectedCities,
        dailyBudget: body.dailyBudget,
        hardCap: body.hardCap,
        phoneNumber: body.phoneNumber || '',
        businessHours: body.businessHours,
      };

      const plan = await service.generatePlan(request, accountId, userId);

      res.json({ success: true, data: plan });
    } catch (err) {
      console.error('[Route] Plan generation error:', err);
      res.status(500).json({
        error: 'Plan generation failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/plan/:id
   *
   * Returns a previously stored campaign plan.
   */
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const { accountId } = req.auth!;
      const planId = req.params.id;

      const db = getDb();
      const { data, error } = await db
        .from('growth_campaign_plans')
        .select('id, analysis_id, plan_data, created_at')
        .eq('id', planId)
        .eq('account_id', accountId)
        .single();

      if (error || !data) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      res.json({
        success: true,
        data: {
          id: data.id,
          analysisId: data.analysis_id,
          ...data.plan_data,
          createdAt: data.created_at,
        },
      });
    } catch (err) {
      console.error('[Route] Get plan error:', err);
      res.status(500).json({ error: 'Failed to retrieve plan' });
    }
  });

  return router;
}
