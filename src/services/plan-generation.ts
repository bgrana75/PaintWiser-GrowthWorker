/**
 * Plan Generation Service
 *
 * Takes a completed market analysis + user selections and generates
 * a concrete Google Ads campaign plan.
 *
 * Flow:
 * 1. Load the stored market analysis
 * 2. Build LLM plan input from user selections
 * 3. Generate campaign plan via LLM
 * 4. Store the plan and log usage
 */

import type { PlanGenerationRequest, CampaignPlan } from '../types.js';
import type { LlmProvider, LlmPlanInput } from '../providers/interfaces.js';
import { getDb, logUsageEvent, saveCampaignPlan } from '../db.js';

export class PlanGenerationService {
  private llm: LlmProvider;

  constructor(llm: LlmProvider) {
    this.llm = llm;
  }

  async generatePlan(
    request: PlanGenerationRequest,
    accountId: string,
    userId: string,
  ): Promise<CampaignPlan> {
    const startTime = Date.now();
    console.log(`[PlanGen] Starting for account=${accountId}, analysisId=${request.analysisId}`);

    // Step 1: Load the stored market analysis
    const db = getDb();
    const { data: analysis, error } = await db
      .from('growth_market_analyses')
      .select('result_data')
      .eq('id', request.analysisId)
      .eq('account_id', accountId)
      .single();

    if (error || !analysis) {
      throw new Error(`Market analysis not found: ${request.analysisId}`);
    }

    const marketAnalysis = analysis.result_data;

    // Step 2: Build LLM input
    const llmInput: LlmPlanInput = {
      marketAnalysis: {
        summary: marketAnalysis.overview?.summary || '',
        serviceOpportunities: marketAnalysis.serviceOpportunities || [],
        competitors: marketAnalysis.competitors || [],
        budgetRecommendation: marketAnalysis.budgetRecommendation || {},
      },
      selectedServices: request.selectedServices,
      selectedCities: request.selectedCities,
      dailyBudget: request.dailyBudget,
      hardCap: request.hardCap,
      phoneNumber: request.phoneNumber,
    };

    // Step 3: Generate via LLM
    const llmOutput = await this.llm.generateCampaignPlan(llmInput);

    // Step 4: Assemble the CampaignPlan
    const plan: CampaignPlan = {
      analysisId: request.analysisId,
      campaigns: llmOutput.campaigns.map(c => ({
        name: c.name,
        service: c.service,
        targetCity: c.targetCity,
        dailyBudget: c.dailyBudget,
        keywords: c.keywords,
        negativeKeywords: c.negativeKeywords || [],
        adCopy: c.adCopy,
        estimatedClicksPerDay: c.estimatedClicksPerDay,
        estimatedCostPerClick: c.estimatedCostPerClick,
      })),
      totalDailyBudget: request.dailyBudget,
      hardCap: request.hardCap,
      summary: llmOutput.summary,
      generatedAt: new Date().toISOString(),
    };

    const elapsed = Date.now() - startTime;
    console.log(`[PlanGen] Complete in ${elapsed}ms, ${plan.campaigns.length} campaigns`);

    // Step 5: Store and log
    const planId = await saveCampaignPlan(
      accountId,
      userId,
      request.analysisId,
      plan as any,
    );

    await logUsageEvent(accountId, userId, 'plan_generation', {
      analysisId: request.analysisId,
      campaignCount: plan.campaigns.length,
      elapsedMs: elapsed,
      planId,
    });

    // Attach plan ID
    (plan as any).id = planId;

    return plan;
  }
}
