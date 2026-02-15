/**
 * Market Analysis Service
 *
 * Orchestrates the full market analysis pipeline:
 * 1. Gather keyword data (estimates or Keyword Planner)
 * 2. Gather competitor data (Google Places)
 * 3. Optionally gather SERP data (Serper.dev)
 * 4. Read CRM data from Supabase
 * 5. Synthesize everything through LLM
 * 6. Store result and log usage
 *
 * This is the "virtual marketing agency" brain — it takes business info
 * and produces the same analysis a human strategist would.
 */

import type { MarketAnalysisRequest, MarketAnalysis, MarketOverview, SerpResult } from '../types.js';
import type { MarketDataProvider, CompetitorProvider, LlmProvider, LlmMarketAnalysisInput } from '../providers/interfaces.js';
import { getCrmSnapshot, logUsageEvent, saveMarketAnalysis } from '../db.js';
import { analyzeWebsite, formatWebsiteForPrompt } from './website-analyzer.js';

interface MarketAnalysisServiceDeps {
  marketData: MarketDataProvider;
  competitors: CompetitorProvider;
  serpProvider: CompetitorProvider | null; // null if SERP disabled
  llm: LlmProvider;
}

export class MarketAnalysisService {
  private deps: MarketAnalysisServiceDeps;

  constructor(deps: MarketAnalysisServiceDeps) {
    this.deps = deps;
  }

  async analyze(
    request: MarketAnalysisRequest,
    accountId: string,
    userId: string,
  ): Promise<MarketAnalysis> {
    const startTime = Date.now();
    console.log(`[Analysis] Starting for account=${accountId}, zip=${request.zipCode}, services=${request.services.join(', ')}`);

    // Step 1: Fetch competitors + CRM + SERP + Website in parallel (no dependencies)
    const [competitors, serpResults, crmData, websiteData] = await Promise.all([
      this.deps.competitors.getCompetitors(
        request.zipCode,
        request.radiusMiles,
      ).catch(err => {
        console.error('[Analysis] Competitor data error:', err);
        return [];
      }),

      this.gatherSerpResults(request).catch(err => {
        console.error('[Analysis] SERP data error:', err);
        return [] as SerpResult[];
      }),

      getCrmSnapshot(accountId).catch(err => {
        console.error('[Analysis] CRM data error:', err);
        return null;
      }),

      request.websiteUrl
        ? analyzeWebsite(request.websiteUrl).then(result => {
            console.log(`[Analysis] Website fetched: ${result.url}, title="${result.title}", ${result.servicePages.length} service pages, error=${result.error || 'none'}`);
            return formatWebsiteForPrompt(result);
          }).catch(err => {
            console.error('[Analysis] Website fetch error:', err);
            return null;
          })
        : Promise.resolve(null),
    ]);

    // Step 2: Fetch real keyword data from Google Ads Keyword Planner
    const keywords = await this.deps.marketData.getKeywordData(
      request.services,
      request.targetCities || [],
      '', // state derived from zip geocoding
    ).catch(err => {
      console.error('[Analysis] Keyword data error:', err);
      return [];
    });

    console.log(`[Analysis] Data gathered: ${keywords.length} keywords, ${competitors.length} competitors, ${serpResults.length} SERP results, CRM=${crmData ? 'yes' : 'no'}, website=${websiteData ? 'yes' : 'no'}`);

    // Step 4: LLM synthesis
    const llmInput: LlmMarketAnalysisInput = {
      services: request.services,
      zipCode: request.zipCode,
      keywords,
      competitors,
      serpResults,
      crmData,
      websiteUrl: request.websiteUrl,
      websiteContent: websiteData || undefined,
    };

    const llmOutput = await this.deps.llm.synthesizeMarketAnalysis(llmInput);

    // Step 5: Assemble the final MarketAnalysis
    const overview: MarketOverview = {
      summary: llmOutput.summary,
      competitionLevel: llmOutput.competitionLevel as 'low' | 'medium' | 'high',
      marketInsight: llmOutput.marketInsight,
      ...(llmOutput.websiteAnalysis ? { websiteAnalysis: llmOutput.websiteAnalysis } : {}),
    };

    const analysis: MarketAnalysis = {
      overview,
      serviceOpportunities: llmOutput.serviceOpportunities,
      competitors: llmOutput.competitorSnapshots,
      recommendedCities: llmOutput.recommendedCities,
      budgetRecommendation: llmOutput.budgetRecommendation,
      dataSourcesUsed: this.getDataSourcesUsed(keywords.length, competitors.length, serpResults.length, !!crmData),
      generatedAt: new Date().toISOString(),
    };

    const elapsed = Date.now() - startTime;
    console.log(`[Analysis] Complete in ${elapsed}ms`);

    // Step 6: Store and log
    const analysisId = await saveMarketAnalysis(
      accountId,
      userId,
      request as any,
      analysis as any,
    );

    await logUsageEvent(accountId, userId, 'market_analysis', {
      zipCode: request.zipCode,
      services: request.services,
      elapsedMs: elapsed,
      analysisId,
    });

    // Attach the ID so the frontend can reference it
    (analysis as any).id = analysisId;

    return analysis;
  }

  private async gatherSerpResults(request: MarketAnalysisRequest): Promise<SerpResult[]> {
    if (!this.deps.serpProvider) return [];

    const queries: string[] = [];
    for (const service of request.services.slice(0, 3)) {
      queries.push(`${service} ${request.zipCode}`);
      if (request.targetCities?.[0]) {
        queries.push(`${service} ${request.targetCities[0]}`);
      }
    }

    const results: SerpResult[] = [];
    // Limit to 3 SERP queries max to control costs
    for (const query of queries.slice(0, 3)) {
      const result = await this.deps.serpProvider.getSerpResults?.(
        query,
        request.zipCode,
      );
      if (result) results.push(result);
    }

    return results;
  }

  private getDataSourcesUsed(
    keywordCount: number,
    competitorCount: number,
    serpCount: number,
    hasCrm: boolean,
  ): string[] {
    const sources: string[] = [];
    if (keywordCount > 0) sources.push('google_ads_keyword_planner');
    if (competitorCount > 0) sources.push('google_places');
    if (serpCount > 0) sources.push('serper_serp');
    if (hasCrm) sources.push('crm_data');
    sources.push('openai_llm');
    return sources;
  }
}
