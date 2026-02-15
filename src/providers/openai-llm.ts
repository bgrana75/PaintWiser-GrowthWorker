/**
 * OpenAI LLM Provider — AI Synthesis
 *
 * Takes gathered data (keywords, competitors, CRM) and produces
 * structured strategy outputs via GPT-4o.
 *
 * Uses JSON mode for reliable structured output.
 */

import OpenAI from 'openai';
import type { Config } from '../config.js';
import type { AdCopy } from '../types.js';
import type {
  LlmProvider,
  LlmMarketAnalysisInput,
  LlmMarketAnalysisOutput,
  LlmPlanInput,
  LlmPlanOutput,
} from './interfaces.js';

export class OpenAiLlmProvider implements LlmProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: Config) {
    this.client = new OpenAI({ apiKey: config.openaiApiKey });
    this.model = config.openaiModel;
  }

  async synthesizeMarketAnalysis(input: LlmMarketAnalysisInput): Promise<LlmMarketAnalysisOutput> {
    // Compute data-driven budget guidance from actual keyword CPC data
    const cpcValues = input.keywords.map(k => k.avgCpc).filter(c => c > 0);
    const hasKeywordData = cpcValues.length > 0;
    const avgCpc = hasKeywordData
      ? Math.round(cpcValues.reduce((a, b) => a + b, 0) / cpcValues.length * 100) / 100
      : null;
    const minCpc = hasKeywordData ? Math.min(...cpcValues) : null;
    const maxCpc = hasKeywordData ? Math.max(...cpcValues) : null;
    // Daily budget should afford at least 3-8 clicks/day
    const suggestedDailyLow = avgCpc ? Math.round(avgCpc * 3) : null;
    const suggestedDailyHigh = avgCpc ? Math.round(avgCpc * 8) : null;

    const systemPrompt = `You are an expert Google Ads marketing strategist specializing in the painting contractor industry. You analyze market data and produce actionable recommendations.

CRITICAL RULES:
${hasKeywordData ? `- You MUST use the avgCpc values from the keyword data provided below. Do NOT invent or estimate your own CPC values.
- The serviceOpportunities avgCpc MUST match the weighted average CPC from the keyword data for that service.
- Budget recommendations MUST be derived from the actual CPC data, not from generic assumptions.` : `- NO KEYWORD DATA IS AVAILABLE. The Google Ads Keyword Planner API did not return data (likely pending API access approval).
- Set all CPC, monthlySearches, estimatedSearches, and budget values to 0 or null.
- Do NOT invent, estimate, or hallucinate any CPC or search volume numbers.
- Focus your analysis on competitor data and CRM data only.
- In your summary, explicitly note that keyword/CPC data is unavailable and the analysis is limited.`}
- You MUST respond with valid JSON matching the exact schema provided. No markdown, no explanation outside the JSON.`;

    const userPrompt = `Analyze this market data for a painting contractor and produce a strategic recommendation.

## Business Info
- Services offered: ${input.services.join(', ')}
- Location (zip code): ${input.zipCode}
${input.websiteContent ? `- Business website: ${input.websiteUrl}\n\n## Website Content (ACTUALLY FETCHED — base your analysis on this real data)\n${input.websiteContent}` : input.websiteUrl ? `- Business website: ${input.websiteUrl} (could not fetch — provide general recommendations)` : '- Business website: Not provided'}

## Keyword Data (search volumes & CPC estimates)
${hasKeywordData ? `IMPORTANT: These CPC values are real data from Google Ads Keyword Planner. Use them directly — do NOT substitute your own CPC numbers.
Average CPC across all keywords: $${avgCpc} (range: $${minCpc} - $${maxCpc})
${JSON.stringify(input.keywords.slice(0, 50), null, 2)}` : `⚠️ NO KEYWORD DATA AVAILABLE — Google Ads Keyword Planner did not return results.
This likely means the developer token is still in test mode (Basic Access pending approval).
You MUST set all avgCpc to 0, all monthlySearches to 0, and all estimatedSearches to 0 or null.
Do NOT invent or guess any CPC or search volume numbers. Explicitly note this limitation in your summary.`}

## Competitors Found (${input.competitors.length} total)
${JSON.stringify(input.competitors.slice(0, 15), null, 2)}

${input.serpResults.length > 0 ? `## SERP Analysis (competitor ads)\n${JSON.stringify(input.serpResults.slice(0, 5), null, 2)}` : '## SERP Analysis\nNot available.'}

${input.crmData ? `## CRM Data (business performance)\n${JSON.stringify(input.crmData, null, 2)}` : '## CRM Data\nNo CRM data available — this is a new user.'}

## Budget Guidance
${hasKeywordData ? `Derived from real keyword data above:
- Average CPC: $${avgCpc}
- Suggested daily budget range: $${suggestedDailyLow}-$${suggestedDailyHigh}/day (enough for 3-8 clicks/day at avg CPC)
- Monthly hard cap should be 20-30x daily budget` : `⚠️ No CPC data available — cannot compute budget guidance.
Set all budget values (recommendedDailyBudget, recommendedHardCap) to 0.
Set estimatedClicksPerDay, estimatedCallsPerWeek, estimatedCostPerCall to 0.
Set projectedRevenuePerMonth and projectedRoi to null.
In the rationale, explain that budget recommendations require real keyword CPC data which is currently unavailable.`}

## Required JSON Output Schema:
{
  "summary": "2-3 sentence executive summary of the market opportunity",
  "competitionLevel": "low" | "medium" | "high",
  "marketInsight": "1-2 sentence insight about this specific market",
${input.websiteContent ? `  "websiteAnalysis": "2-4 sentence analysis based on the ACTUAL website content provided above. Reference specific pages, CTAs, and features you found. Mention what the site does WELL (e.g., has service pages, good CTAs, reviews displayed) AND what could be improved for Google Ads performance (e.g., missing city landing pages, could add more trust signals, needs better keyword targeting on service pages). Be specific and reference actual content from the site.",` : input.websiteUrl ? `  "websiteAnalysis": "General website recommendations since the site could not be fetched.",` : ''}
  "serviceOpportunities": [
    {
      "service": "service name",
      "monthlySearches": ${hasKeywordData ? 'number (sum from keyword data for this service)' : '0 (no keyword data available — MUST be 0)'},
      "avgCpc": ${hasKeywordData ? 'number (weighted average from keyword data for this service — DO NOT invent this)' : '0 (no keyword data available — MUST be 0)'},
      "competition": "low" | "medium" | "high",
      "crmWinRate": number or null,
      "crmAvgDealSize": number or null,
      "crmQuoteCount": number or null,
      "recommendation": "specific actionable recommendation for this service",
      "rank": number (1 = best opportunity)
    }
  ],
  "competitorSnapshots": [
    {
      "name": "business name",
      "rating": number or null,
      "reviewCount": number or null,
      "address": "address or null",
      "adHeadlines": ["headline1"] or null,
      "adDescriptions": ["desc1"] or null,
      "insight": "what can we learn from this competitor or exploit"
    }
  ],
  "recommendedCities": [
    // IMPORTANT: Provide 15-20 cities, neighborhoods, and suburbs within a reasonable radius (roughly 25-30 miles).
    // Include the main city, surrounding suburbs, affluent neighborhoods, and nearby towns.
    // Think about where homeowners with painting budgets live — affluent suburbs, established neighborhoods, etc.
    // Order by estimated opportunity (most valuable markets first).
    // Mark the top 8-10 as "recommended: true" and the rest as "recommended: false".
${hasKeywordData ? `    // VARY the avgCpc and estimatedSearches per city — affluent suburbs and high-demand areas should have higher CPC
    // and more searches, while smaller/less competitive neighborhoods should have lower CPC. Use the keyword data
    // CPC as a baseline and adjust ±10-30% depending on the city's affluence and competition.` : `    // NO KEYWORD DATA AVAILABLE — set estimatedSearches and avgCpc to 0 or null for ALL cities.
    // Do NOT invent or estimate search volumes or CPC values.`}
    {
      "city": "city or neighborhood name",
      "state": "state code (derived from the zip code)",
      "estimatedSearches": ${hasKeywordData ? 'number or null (vary by city size and demand — larger cities get more, smaller suburbs less)' : 'null (no data available)'},
      "avgCpc": ${hasKeywordData ? 'number or null (vary by city — use keyword CPC as baseline, adjust ±10-30% based on city affluence/competition)' : 'null (no data available)'},
      "competition": "low" | "medium" | "high" or null (should vary by city — some areas are more saturated than others),
      "distanceMiles": number or null,
      "reason": "why this city is recommended — mention demographics, home values, or demand",
      "recommended": true/false
    }
  ],
  "budgetRecommendation": {
${hasKeywordData ? `    "recommendedDailyBudget": number (use the budget guidance above — should be $${suggestedDailyLow}-$${suggestedDailyHigh}/day based on actual CPC data),
    "recommendedHardCap": number (MONTHLY hard cap in dollars — pauses all ads once reached. Should be 20x-30x the daily budget),
    "estimatedClicksPerDay": number (= daily budget / avg CPC),
    "estimatedCallsPerWeek": number,
    "estimatedCostPerCall": number,
    "projectedRevenuePerMonth": number or null (only if CRM data available),
    "projectedRoi": number or null (only if CRM data available),
    "rationale": "explain the budget recommendation referencing the actual CPC data"` : `    "recommendedDailyBudget": 0 (no CPC data available — MUST be 0),
    "recommendedHardCap": 0 (no CPC data available — MUST be 0),
    "estimatedClicksPerDay": 0,
    "estimatedCallsPerWeek": 0,
    "estimatedCostPerCall": 0,
    "projectedRevenuePerMonth": null,
    "projectedRoi": null,
    "rationale": "Budget recommendations are unavailable because keyword CPC data could not be retrieved from Google Ads Keyword Planner. This is likely because the developer token is pending Basic Access approval. Once approved, real CPC data will be available and accurate budget recommendations can be provided."`}
  }
}

Focus on:
${hasKeywordData ? `1. Which services have the best ROI opportunity (low CPC + high volume + high win rate if CRM data available)
2. Realistic budget recommendations derived from the actual CPC data provided
3. Specific competitor weaknesses to exploit` : `1. Competitor landscape analysis — focus on what data IS available
2. CRM insights if available
3. Clearly note that keyword/CPC/budget data is unavailable and recommendations are limited`}
4. Provide 15-20 cities/neighborhoods/suburbs within 25-30 miles of the zip code, ranked by opportunity — include affluent areas and established neighborhoods where homeowners invest in painting. The main city plus surrounding suburbs, towns, and well-known neighborhoods.
5. Be honest about competition — don't oversell if it's tough
${input.websiteContent ? '6. Analyze their ACTUAL website content provided above — do NOT guess or assume what pages exist. Reference specific service pages, CTAs, reviews, and content you found. Be accurate about what is present and what is missing.' : input.websiteUrl ? '6. Provide general website improvement recommendations since the site could not be fetched.' : ''}`;

    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty response');

    const parsed = JSON.parse(content) as LlmMarketAnalysisOutput;
    return parsed;
  }

  async generateCampaignPlan(input: LlmPlanInput): Promise<LlmPlanOutput> {
    const systemPrompt = `You are an elite Google Ads campaign strategist who has managed $10M+ in ad spend for painting contractors across the US. You build campaigns that rival top marketing agencies.

You understand:
- Google Responsive Search Ads (RSAs) require 15 headlines (max 30 chars each) and 4 descriptions (max 90 chars each)
- Keyword strategy should include 15-25 keywords per campaign across BROAD, PHRASE, and EXACT match types
- Ad copy should leverage competitor weaknesses, social proof, urgency, and local trust signals
- Budget allocation should favor highest-opportunity services and cities
- Negative keywords are essential to prevent wasted spend

You MUST respond with valid JSON matching the exact schema provided.`;

    // Build competitor ad insights for the prompt
    const competitorInsights = input.marketAnalysis.competitors
      .filter(c => c.insight)
      .map(c => `- ${c.name} (${c.rating}★, ${c.reviewCount} reviews): ${c.insight}`)
      .join('\n');

    const userPrompt = `Build a professional Google Ads campaign plan for a painting contractor. This should be agency-quality work.

## Market Analysis Summary
${input.marketAnalysis.summary}

## User Selections
- Services: ${input.selectedServices.join(', ')}
- Target Cities/Neighborhoods: ${input.selectedCities.join(', ')}
- Total Daily Budget: $${input.dailyBudget}
- Monthly Hard Cap: $${input.hardCap}
- Phone Number: ${input.phoneNumber}

## Service Opportunity Data (use the avgCpc values — do NOT invent CPC values)
${JSON.stringify(input.marketAnalysis.serviceOpportunities, null, 2)}

## Competitor Intelligence (exploit their weaknesses in your ads)
${competitorInsights || 'No competitor data available.'}
${JSON.stringify(input.marketAnalysis.competitors.slice(0, 5), null, 2)}

## Budget Recommendation from Analysis
${JSON.stringify(input.marketAnalysis.budgetRecommendation, null, 2)}

## Campaign Structure Rules:
1. **One campaign per service** (NOT per service×city). Target ALL selected cities within each campaign.
   - Campaign naming: "[PW] {Service}" (e.g., "[PW] Interior Painting")
   - Each campaign targets all selected cities/neighborhoods via location targeting
2. **Budget allocation**: Split daily budget proportionally by opportunity rank. Higher-ranked services get more budget.
3. **estimatedCostPerClick** MUST match the avgCpc from service opportunity data — do NOT invent CPC values
4. **estimatedClicksPerDay** = campaign daily budget / estimatedCostPerClick

## Keyword Rules (15-25 keywords per campaign):
- Include a strategic mix of BROAD, PHRASE, and EXACT match types
- Cover these keyword categories for each service:
  a) Core service keywords: "interior painting", "house painting"
  b) Intent keywords: "interior painter near me", "get house painted"  
  c) City-modified keywords: "{service} {city}" for the top 3-5 target cities
  d) Problem/need keywords: "peeling paint repair", "ceiling painting"
  e) Commercial intent: "painting estimate", "painting quote", "painting cost"
  f) Quality signals: "professional painter", "licensed painter"
- Also provide 5-10 negative keywords per campaign to prevent waste (e.g., "DIY", "paint store", "jobs", "hiring", "salary", "how to")

## Ad Copy Rules (Google Responsive Search Ads / RSA format):
- **15 headlines** (max 30 chars each) — Google RSAs need this many to optimize rotation
  Include headlines that cover:
  a) Service name + city (e.g., "Interior Painting San Diego")
  b) USPs: "Licensed & Insured Painters", "Free Estimates"
  c) Social proof: "5-Star Rated", "Trusted Since 20XX"
  d) Urgency: "Book This Week & Save", "Limited Availability"
  e) Price/value: "Competitive Pricing", "No Hidden Fees"
  f) Trust: "100% Satisfaction Guaranteed", "Local Family Owned"
  g) Action: "Call Now for Free Quote", "Get Your Price Today"
  h) Differentiators exploiting competitor weaknesses
- **4 descriptions** (max 90 chars each):
  a) Main value prop with call to action
  b) Services/scope description
  c) Trust/social proof sentence
  d) Urgency/promotion description
- Every headline and description must be UNIQUE — no duplicates
- Reference competitor weaknesses where possible (e.g., if competitors have low ratings, emphasize your quality)

## Required JSON Output Schema:
{
  "campaigns": [
    {
      "name": "[PW] Service Name",
      "service": "service name",
      "targetCity": "Primary City (all selected cities targeted)",
      "dailyBudget": number,
      "keywords": [
        { "keyword": "keyword text", "matchType": "BROAD" | "PHRASE" | "EXACT" }
      ],
      "negativeKeywords": ["negative keyword 1", "negative keyword 2"],
      "adCopy": {
        "headlines": ["h1", "h2", ... 15 headlines total],
        "descriptions": ["d1", "d2", "d3", "d4"]
      },
      "estimatedClicksPerDay": number,
      "estimatedCostPerClick": number
    }
  ],
  "summary": "professional summary of the plan: total campaigns, keywords, expected clicks/calls, and projected results"
}`;

    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 8000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty response');

    return JSON.parse(content) as LlmPlanOutput;
  }

  async generateAdCopy(service: string, city: string, competitorInsights: string[]): Promise<AdCopy> {
    const systemPrompt = `You are a Google Ads copywriter for painting contractors. Write compelling ad copy.
Respond with JSON: { "headlines": [...], "descriptions": [...] }
Headlines: max 30 characters each, provide 5-8.
Descriptions: max 90 characters each, provide 2-3.`;

    const userPrompt = `Write Google Ads copy for a painting contractor.
Service: ${service}
City: ${city}
${competitorInsights.length > 0 ? `Competitor insights to leverage:\n${competitorInsights.join('\n')}` : ''}

Focus on: free estimates, licensed & insured, local trust, urgency.`;

    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 1000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty response');

    return JSON.parse(content) as AdCopy;
  }
}
